/** Настройки — соединение, трейдинг, AI, биржи, уведомления, внешний вид, данные. */
import { h, icon, mount } from '../core/dom.js';
import { state, set, on, resetAll, exportState, importState } from '../core/store.js';
import { fmt0, compact } from '../core/format.js';
import { EXCHANGES } from '../data/exchanges.js';
import { WEIGHT_LABELS } from '../services/analysis.js';
import { restartFeed, setFeedMode, feedMode } from '../services/feed.js';
import { openSheet, confirmSheet } from '../ui/sheet.js';
import { toast } from '../ui/toast.js';

export function SettingsScreen() {
  const root = h('div.stagger');
  const unsubs = [];
  const aiSlot = h('div');
  const exSlot = h('div');

  /* ---------- helpers ---------- */

  const sw = (title, sub, key, onAfter) => {
    const btn = h('button.switch', { role: 'switch', 'aria-checked': String(Boolean(state.settings[key])) });
    btn.addEventListener('click', () => {
      set('settings', (s) => { s[key] = !s[key]; });
      btn.setAttribute('aria-checked', String(state.settings[key]));
      onAfter?.(state.settings[key]);
    });
    return h('div.switch-row', h('div.sr-main', h('div.sr-title', title), sub ? h('div.sr-sub', sub) : null), btn);
  };

  const num = (label, key, { hint, min = 0, step = 'any', onAfter } = {}) => {
    const input = h('input.input.num', {
      type: 'text', inputmode: 'decimal', value: String(state.settings[key]),
      onChange: (e) => {
        const n = Number(e.target.value.replace(',', '.'));
        if (!Number.isFinite(n) || n < min) { e.target.value = state.settings[key]; return toast('Некорректное значение', null, 'err'); }
        set('settings', (s) => { s[key] = n; });
        onAfter?.(n);
      },
    });
    return h('label.field', h('span.label', label, hint ? h('span.hint', hint) : null), input);
  };

  const slider = (label, key, min, max, step, unit, onAfter) => {
    const out = h('span.mono.t-sm.t-acid', `${state.settings[key]}${unit}`);
    const sl = h('input.slider', {
      type: 'range', min, max, step, value: state.settings[key],
      style: { '--fill': `${((state.settings[key] - min) / (max - min)) * 100}%` },
      onInput: (e) => {
        const v = Number(e.target.value);
        out.textContent = `${v}${unit}`;
        e.target.style.setProperty('--fill', `${((v - min) / (max - min)) * 100}%`);
        set('settings', (s) => { s[key] = v; });
        onAfter?.(v);
      },
    });
    return h('div.field', h('span.label', label, h('span.hint', out)), sl);
  };

  const title = (text, i, aside) => h('div.section-title', { style: { '--i': i } }, h('span.eyebrow', text), h('i.rule'), aside || null);

  /* ---------- connection ---------- */

  const wsInput = h('input.input.mono', {
    value: state.settings.wsUrl, spellcheck: 'false',
    onChange: (e) => {
      const v = e.target.value.trim();
      if (!/^wss?:\/\/.+/.test(v)) { e.target.value = state.settings.wsUrl; return toast('Нужен URL вида wss://host/path', null, 'err'); }
      set('settings', (s) => { s.wsUrl = v; });
      toast('Эндпоинт сохранён', v, 'ok');
    },
  });

  const modeSeg = h('div.seg',
    ['mock', 'live'].map((m) => h('button', {
      'aria-pressed': String(state.settings.feedMode === m),
      onClick: (e) => {
        setFeedMode(m);
        for (const b of e.target.parentNode.children) b.setAttribute('aria-pressed', 'false');
        e.target.setAttribute('aria-pressed', 'true');
        toast(m === 'live' ? 'LIVE WebSocket' : 'MOCK генератор', m === 'live' ? state.settings.wsUrl : 'Данные генерируются локально', 'info');
      },
    }, m === 'mock' ? 'MOCK (демо)' : 'LIVE (WS)')),
  );

  const connection = h('div',
    h('div.panel.panel-body',
      h('label.field', h('span.label', 'Источник данных', h('span.hint', 'бэкенд ещё не подключён')), modeSeg),
      h('label.field', h('span.label', 'WebSocket эндпоинт'), wsInput),
      h('div.grid-2',
        num('Троттлинг, мс', 'throttleMs', { hint: '120–3000', min: 120, onAfter: () => restartFeed() }),
        num('Буфер логов', 'maxLogs', { hint: 'записей', min: 50 }),
      ),
    ),
    h('div.panel',
      sw('Авто-переподключение', 'Экспоненциальный backoff до 30 с', 'autoReconnect'),
      h('button.row', { onClick: () => { restartFeed(); toast('Фид перезапущен', null, 'ok'); } },
        h('div.deal-ico', icon('refresh')),
        h('div.row-main', h('div.row-title', 'Перезапустить фид'), h('div.row-sub', 'Сброс стаканов и повторная подписка')),
        icon('chev', { class: 'row-chev' }),
      ),
    ),
    h('div.note', { style: { marginTop: '10px' } }, icon('info'),
      h('div', 'В режиме LIVE фронт говорит по собственному протоколу (', h('code', 'docs/ws-protocol.md'), '). Адаптеры бирж живут на бэкенде — ключи и подписи не попадают в мини-апп.')),
  );

  /* ---------- trading ---------- */

  const trading = h('div',
    h('div.panel.panel-body',
      h('div.grid-2',
        num('Объём по умолч.', 'volume', { hint: 'USDT' }),
        num('Лимит на сделку', 'maxPerDeal', { hint: 'USDT' }),
      ),
      num('Дневной лимит', 'dayLimit', { hint: 'USDT' }),
      slider('Допустимый слиппедж', 'slippageTol', 0, 3, 0.05, '%'),
      slider('Мин. спред для сигнала', 'minSpread', 0, 5, 0.1, '%'),
      slider('Целевая маржа выхода', 'targetMargin', 0.1, 10, 0.1, '%'),
      slider('Комиссия биржи', 'exchangeFee', 0, 1, 0.01, '%'),
    ),
    h('div.panel',
      sw('Подтверждение сделок', 'Спрашивать перед отправкой ордера', 'confirmDeals'),
      sw('Авто-отказ по риску', 'AI блокирует оферы с вердиктом «высокий риск»', 'autoRejectRisky'),
    ),
  );

  /* ---------- AI ---------- */

  function renderAi() {
    const w = state.settings.weights;
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    mount(aiSlot,
      h('div.panel.panel-body',
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' } },
          h('span.ai-badge', icon('cpu'), 'веса модели'),
          h('span.t-xs.t-muted.mono', { style: { marginLeft: 'auto' } }, `Σ ${sum}`),
        ),
        Object.keys(w).map((k) => {
          const out = h('span.mono.t-sm.t-acid', String(w[k]));
          return h('div.field',
            h('span.label', WEIGHT_LABELS[k] || k, h('span.hint', out)),
            h('input.slider', {
              type: 'range', min: 0, max: 50, step: 1, value: w[k],
              style: { '--fill': `${(w[k] / 50) * 100}%` },
              onInput: (e) => {
                const v = Number(e.target.value);
                out.textContent = String(v);
                e.target.style.setProperty('--fill', `${(v / 50) * 100}%`);
                set('settings', (s) => { s.weights[k] = v; });
              },
            }),
          );
        }),
        slider('Мин. уверенность вердикта', 'minConfidence', 0, 100, 1, '%'),
      ),
      h('div.panel',
        sw('AI-анализ контекста сделки', 'Вердикт, факторы риска и план исполнения', 'aiEnabled'),
        h('button.row', {
          onClick: () => {
            set('settings', (s) => { s.weights = { reputation: 25, price: 25, liquidity: 15, method: 15, speed: 10, exchange: 10 }; });
            renderAi();
            toast('Веса сброшены к базовым', null, 'ok');
          },
        },
          h('div.deal-ico', icon('refresh')),
          h('div.row-main', h('div.row-title', 'Сбросить веса'), h('div.row-sub', 'Вернуть профиль модели по умолчанию')),
          icon('chev', { class: 'row-chev' }),
        ),
      ),
    );
  }
  renderAi();

  /* ---------- exchanges ---------- */

  function renderExchanges() {
    mount(exSlot,
      h('div.panel.panel-flush',
        EXCHANGES.map((ex) => {
          const enabled = state.filters.exchanges.includes(ex.id);
          const hasKey = Boolean(state.settings.apiKeys[ex.id]);
          const btn = h('button.switch', { role: 'switch', 'aria-checked': String(enabled) });
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            set('filters', (f) => {
              const i = f.exchanges.indexOf(ex.id);
              if (i > -1) { if (f.exchanges.length === 1) return toast('Нужна хотя бы одна биржа', null, 'warn'); f.exchanges.splice(i, 1); }
              else f.exchanges.push(ex.id);
            });
            renderExchanges();
          });
          return h('div.switch-row',
            h('div.pc-logo', { style: { background: ex.tint, flex: '0 0 auto' } }, ex.tag[0]),
            h('button.sr-main', { style: { textAlign: 'left' }, onClick: () => openKeySheet(ex) },
              h('div.sr-title', ex.name, hasKey ? h('span.badge.badge-buy', { style: { marginLeft: '6px' } }, 'key') : null),
              h('div.sr-sub.mono', { style: { fontSize: '10.5px' } }, `${(ex.reliability * 100).toFixed(0)}% uptime · ~${ex.baseLatency} ms`),
            ),
            btn,
          );
        }),
      ),
      h('div.note', { style: { marginTop: '10px' } }, icon('key'),
        'API-ключи хранятся только в localStorage этого устройства и используются для приватных эндпоинтов (лимиты, собственные объявления). Публичные стаканы читаются без ключей.'),
    );
  }
  renderExchanges();

  function openKeySheet(ex) {
    const cur = state.settings.apiKeys[ex.id] || { key: '', secret: '' };
    const keyIn = h('input.input.mono', { value: cur.key, placeholder: 'API key', spellcheck: 'false' });
    const secIn = h('input.input.mono', { value: cur.secret, placeholder: 'API secret', type: 'password' });
    const api = openSheet({
      title: `${ex.name} · API`,
      subtitle: ex.endpoint,
      body: h('div',
        h('label.field', h('span.label', 'Key'), keyIn),
        h('label.field', h('span.label', 'Secret'), secIn),
        h('div.note.warn', { style: { marginTop: '12px' } }, icon('alert'),
          'На проде ключи должны жить на бэкенде. Здесь поле есть для self-hosted сценария: мини-апп передаёт их только своему серверу по TLS.'),
      ),
      foot: [
        h('button.btn.btn-danger', {
          onClick: () => { set('settings', (s) => { delete s.apiKeys[ex.id]; }); renderExchanges(); api.close(); toast('Ключи удалены', ex.name, 'warn'); },
        }, icon('trash')),
        h('button.btn.btn-primary', {
          onClick: () => {
            if (!keyIn.value.trim()) return toast('Введите key', null, 'err');
            set('settings', (s) => { s.apiKeys[ex.id] = { key: keyIn.value.trim(), secret: secIn.value.trim() }; });
            renderExchanges(); api.close(); toast('Ключи сохранены', ex.name, 'ok');
          },
        }, 'Сохранить'),
      ],
    });
  }

  /* ---------- notifications ---------- */

  const notifications = h('div.panel',
    sw('Алерты по спреду', `Сигнал, когда спред к медиане выше порога`, 'notifySpread'),
    h('div.panel-body', slider('Порог спреда', 'notifySpreadPct', 0.2, 5, 0.1, '%')),
    sw('Новые мерчанты', 'Уведомлять о появлении новых оферов в стакане', 'notifyNewMerchant'),
    sw('Статусы сделок', 'Пуш при оплате, отпуске и завершении', 'notifyDealStatus'),
  );

  /* ---------- appearance ---------- */

  const themeSeg = h('div.seg',
    [['dark', 'Тёмная'], ['light', 'Светлая']].map(([v, label]) => h('button', {
      'aria-pressed': String(state.settings.theme === v),
      onClick: (e) => {
        set('settings', (s) => { s.theme = v; });
        document.documentElement.dataset.theme = v;
        document.querySelector('meta[name=theme-color]')?.setAttribute('content', v === 'light' ? '#ffffff' : '#0b0c0f');
        for (const b of e.target.parentNode.children) b.setAttribute('aria-pressed', 'false');
        e.target.setAttribute('aria-pressed', 'true');
      },
    }, label)),
  );

  const appearance = h('div',
    h('div.panel.panel-body', h('label.field', h('span.label', 'Тема'), themeSeg)),
    h('div.panel',
      sw('Компактные строки', 'Скрыть способы оплаты в стакане', 'compactRows'),
      sw('Скрывать баланс при входе', 'Баланс по умолчанию замылен', 'hideBalanceDefault'),
      sw('Виброотклик', 'Haptic feedback в Telegram', 'haptics'),
    ),
  );

  /* ---------- data ---------- */

  const data = h('div.panel.panel-flush',
    h('button.row', {
      onClick: () => {
        const blob = new Blob([exportState()], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `p2p-light-config-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        toast('Конфигурация выгружена', 'JSON со настройками, картами и KYC', 'ok');
      },
    },
      h('div.deal-ico', icon('download')),
      h('div.row-main', h('div.row-title', 'Экспорт конфигурации'), h('div.row-sub', 'Настройки, карты, фильтры, KYC — в JSON')),
      icon('chev', { class: 'row-chev' }),
    ),
    h('button.row', { onClick: openImport },
      h('div.deal-ico', icon('upload')),
      h('div.row-main', h('div.row-title', 'Импорт конфигурации'), h('div.row-sub', 'Вставьте JSON из экспорта')),
      icon('chev', { class: 'row-chev' }),
    ),
    h('button.row', {
      onClick: async () => {
        if (await confirmSheet({
          title: 'Сбросить всё?',
          message: 'Будут удалены баланс, карты, настройки, KYC и история закупок. Действие необратимо.',
          confirmLabel: 'Сбросить', danger: true,
        })) resetAll();
      },
    },
      h('div.deal-ico', { style: { color: 'var(--sell)' } }, icon('trash')),
      h('div.row-main', h('div.row-title.t-sell', 'Сбросить данные'), h('div.row-sub', 'Полная очистка локального состояния')),
      icon('chev', { class: 'row-chev' }),
    ),
  );

  function openImport() {
    const ta = h('textarea.textarea', { placeholder: '{ "settings": { ... } }', rows: 8 });
    const api = openSheet({
      title: 'Импорт конфигурации',
      body: h('div', ta, h('div.note', { style: { marginTop: '10px' } }, icon('info'), 'Приложение перезагрузится после импорта.')),
      foot: [
        h('button.btn.btn-ghost', { onClick: () => api.close() }, 'Отмена'),
        h('button.btn.btn-primary', {
          onClick: () => {
            try { importState(ta.value); } catch { toast('Некорректный JSON', null, 'err'); }
          },
        }, 'Импортировать'),
      ],
    });
  }

  unsubs.push(on('settings', () => { /* persisted automatically */ }));

  root.append(
    title('Соединение', 0, h('span.badge', { class: feedMode() === 'live' ? 'badge-buy' : 'badge-acid' }, feedMode())),
    h('div', { style: { '--i': 1 } }, connection),
    title('Трейдинг', 2),
    h('div', { style: { '--i': 3 } }, trading),
    title('AI-анализ', 4),
    h('div', { style: { '--i': 5 } }, aiSlot),
    title('Биржи', 6, h('span.t-xs.t-muted.mono', `${state.filters.exchanges.length}/${EXCHANGES.length}`)),
    h('div', { style: { '--i': 7 } }, exSlot),
    title('Уведомления', 8),
    h('div', { style: { '--i': 9 } }, notifications),
    title('Внешний вид', 10),
    h('div', { style: { '--i': 11 } }, appearance),
    title('Данные', 12),
    h('div', { style: { '--i': 13 } }, data),
    h('div.foot-note', `P2P Light · сборка фронтенда · ${compact(Object.keys(state.offers).length)} оферов в памяти`),
  );

  return { node: root, destroy: () => unsubs.forEach((u) => u()) };
}
