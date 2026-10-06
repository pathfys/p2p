/** Профиль — KYC-верификация, тариф B2B, безопасность, статистика. */
import { h, icon, mount } from '../core/dom.js';
import { state, set, on, KYC_LEVELS, PLANS, plan, activePlan, planActive, planRemainingMs, trialAvailable, subscribePlan, cancelPlan, kycInfo, DAY_MS } from '../core/store.js';
import { fmt0, fmtN, compact, dateTime, ago, mask } from '../core/format.js';
import { openSheet, confirmSheet } from '../ui/sheet.js';
import { toast } from '../ui/toast.js';
import { STEP_ORDER, STEP_META, stepsFor, validateStep, saveStep, canSubmit, submit, reset } from '../services/kyc.js';
import { inTelegram, closeApp } from '../services/telegram.js';
import { openRegionSheet } from '../ui/regionSheet.js';
import { COUNTRY, CUR } from '../data/regions.js';

export function ProfileScreen() {
  const root = h('div.stagger');
  const unsubs = [];
  const kycSlot = h('div');
  const headSlot = h('div');

  const title = (text, i, aside) => h('div.section-title', { style: { '--i': i } }, h('span.eyebrow', text), h('i.rule'), aside || null);

  const STATUS_RU = { none: 'не начата', draft: 'черновик', pending: 'на проверке', approved: 'одобрена', rejected: 'отклонена' };
  const kycBadge = h('span.badge');
  const statsSlot = h('div');

  function updateKycBadge() {
    const st = state.kyc.status;
    kycBadge.className = 'badge ' + (st === 'approved' ? 'badge-buy' : st === 'pending' ? 'badge-info' : st === 'rejected' ? 'badge-sell' : 'badge-warn');
    kycBadge.textContent = STATUS_RU[st] || st;
  }

  /* ---------------- header ---------------- */

  function renderHead() {
    const p = state.profile;
    const k = state.kyc;
    mount(headSlot,
      h('div.panel',
        h('div.pro-head',
          h('div.avatar', p.photo ? h('img', { src: p.photo, alt: '' }) : (p.name[0] || 'U')),
          h('div.pro-main',
            h('div.pro-name', p.name,
              k.status === 'approved'
                ? h('span.badge.badge-buy', icon('shieldCheck'), `kyc ${k.level}`)
                : h('span.badge.badge-warn', 'kyc 0'),
            ),
            h('div.pro-sub', `${p.handle} · с ${dateTime(p.joinedAt)}`),
          ),
        ),
        h('div.panel-body', { style: { borderTop: '1px solid var(--line-soft)' } },
          h('div.tiles',
            miniTile('Объём всего', `${compact(state.stats.volumeUsdt)}`, 'USDT'),
            miniTile('Сделок', String(state.stats.deals), `${state.stats.deals ? ((state.stats.won / state.stats.deals) * 100).toFixed(0) : 0}% успешных`),
          ),
        ),
      ),
    );
  }

  const miniTile = (l, v, s) => h('div.tile', h('div.tl', l), h('div.tv', v), h('div.ts', s));

  /* ---------------- KYC ---------------- */

  function renderKyc() {
    const k = state.kyc;
    const target = k.level >= 2 ? 3 : k.level + 1 || 1;

    const statusBlock = () => {
      if (k.status === 'pending') {
        return h('div.kyc-banner.pending',
          h('div.kyc-ico', icon('clock', { class: 't-acid pulse' })),
          h('div.kyc-main',
            h('div.kyc-t', `Проверка уровня ${k.pendingLevel ?? target}`),
            h('div.kyc-s', `Отправлено ${ago(k.submittedAt)}. Решение придёт автоматически.`),
          ),
        );
      }
      if (k.status === 'approved') {
        const lim = kycInfo();
        return h('div.kyc-banner.ok',
          h('div.kyc-ico', icon('shieldCheck', { class: 't-buy' })),
          h('div.kyc-main',
            h('div.kyc-t', `Верифицирован · уровень ${k.level}`),
            h('div.kyc-s', `${lim.name} · ${lim.dayLimit === Infinity ? 'без лимита' : fmt0(lim.dayLimit) + ' USDT/сутки'} · проверено ${ago(k.reviewedAt)}`),
          ),
        );
      }
      if (k.status === 'rejected') {
        return h('div.kyc-banner',
          h('div.kyc-ico', icon('alert', { class: 't-sell' })),
          h('div.kyc-main', h('div.kyc-t', 'Заявка отклонена'), h('div.kyc-s', k.rejectReason || 'Проверьте корректность данных и отправьте заново')),
        );
      }
      return h('div.kyc-banner',
        h('div.kyc-ico', icon('shield', { class: 't-warn' })),
        h('div.kyc-main',
          h('div.kyc-t', 'Торговля заблокирована'),
          h('div.kyc-s', 'Для доступа к P2P-закупкам нужен KYC уровня 1 и выше'),
        ),
      );
    };

    const needed = stepsFor(target);
    const doneCount = needed.filter((s) => k.steps[s]).length;

    mount(kycSlot,
      statusBlock(),
      h('div.panel', { style: { marginTop: '10px' } },
        h('div.panel-head',
          h('span.eyebrow', `Шаги уровня ${target}`),
          h('span.t-xs.mono.t-muted', `${doneCount}/${needed.length}`),
        ),
        h('div.steps', { style: { padding: '10px 14px 2px' } },
          needed.map((s) => h('i.step-dot', { class: k.steps[s] ? 'done' : '' })),
        ),
        h('div.panel-flush',
          needed.map((s) => {
            const meta = STEP_META[s];
            const done = k.steps[s];
            return h('button.row', { onClick: () => openStep(s, target), disabled: k.status === 'pending' },
              h('div.deal-ico', { style: { color: done ? 'var(--buy)' : 'var(--ink-3)' } }, icon(done ? 'check' : meta.icon)),
              h('div.row-main',
                h('div.row-title', meta.title, done ? h('span.badge.badge-buy', 'готово') : null),
                h('div.row-sub', meta.sub),
              ),
              icon('chev', { class: 'row-chev' }),
            );
          }),
        ),
        k.status !== 'approved' || k.level < target ? h('div.panel-body', { style: { borderTop: '1px solid var(--line-soft)' } },
          h('button.btn.btn-primary.btn-block', {
            disabled: !canSubmit(target) || k.status === 'pending',
            onClick: () => { if (submit(target)) renderKyc(); },
          }, icon('shieldCheck'), k.status === 'pending' ? 'На проверке…' : `Отправить на верификацию (ур. ${target})`),
        ) : null,
      ),
      h('div.section-title', h('span.eyebrow', 'Уровни и лимиты'), h('i.rule')),
      h('div.levels',
        KYC_LEVELS.slice(1).map((lv) => h('div.level', {
          class: k.level === lv.level ? 'is-current' : k.level < lv.level - 1 ? 'is-locked' : '',
        },
          h('div.level-top',
            h('div.level-n', String(lv.level)),
            h('div.level-t', lv.name),
            k.level >= lv.level ? h('span.badge.badge-buy', icon('check'), 'активен') : h('span.badge', `${stepsFor(lv.level).length} шагов`),
          ),
          h('div.level-lim',
            `${lv.dayLimit === Infinity ? '∞' : fmt0(lv.dayLimit)} USDT / сутки · ${lv.monthLimit === Infinity ? '∞' : fmt0(lv.monthLimit)} USDT / месяц`),
        )),
      ),
      k.status !== 'none' ? h('button.btn.btn-ghost.btn-block', {
        style: { marginTop: '10px' },
        onClick: async () => {
          if (await confirmSheet({ title: 'Сбросить KYC?', message: 'Все заполненные данные верификации будут удалены, торговля снова заблокируется.', confirmLabel: 'Сбросить', danger: true })) {
            reset(); renderKyc(); toast('KYC сброшен', null, 'warn');
          }
        },
      }, icon('refresh'), 'Сбросить верификацию') : null,
    );
  }

  /* ---- step editor ---- */

  function openStep(step, target) {
    const d = { ...state.kyc.data };
    const errBox = h('div');

    const f = (label, key, props = {}) => {
      const input = h('input.input', { value: d[key] ?? '', ...props, onInput: (e) => { d[key] = e.target.value; } });
      return h('label.field', h('span.label', label, props.hint ? h('span.hint', props.hint) : null), input);
    };

    const uploader = (key, label, sub) => {
      const btn = h('button.upload', { class: d[key] ? 'filled' : '' },
        icon(d[key] ? 'check' : 'camera'),
        h('span.ut', d[key] ? 'Загружено' : label),
        h('span.us', sub),
      );
      btn.addEventListener('click', () => {
        // simulated capture; on prod this posts to the KYC provider
        d[key] = !d[key];
        btn.className = `upload ${d[key] ? 'filled' : ''}`;
        mount(btn, icon(d[key] ? 'check' : 'camera'), h('span.ut', d[key] ? 'Загружено' : label), h('span.us', sub));
      });
      return btn;
    };

    const bodies = {
      personal: () => h('div',
        h('div.grid-2',
          f('Имя', 'firstName', { placeholder: 'Иван' }),
          f('Фамилия', 'lastName', { placeholder: 'Иванов' }),
        ),
        f('Дата рождения', 'birthDate', { type: 'date' }),
        h('label.field', h('span.label', 'Страна'),
          h('select.select', { onChange: (e) => { d.country = e.target.value; } },
            [['RU', 'Россия'], ['KZ', 'Казахстан'], ['BY', 'Беларусь'], ['AM', 'Армения'], ['GE', 'Грузия'], ['AE', 'ОАЭ'], ['TR', 'Турция']]
              .map(([v, n]) => h('option', { value: v, selected: d.country === v }, n))),
        ),
      ),
      document: () => h('div',
        h('label.field', h('span.label', 'Тип документа'),
          h('select.select', { onChange: (e) => { d.docType = e.target.value; } },
            [['passport', 'Паспорт'], ['id', 'ID-карта'], ['driver', 'Водительское удостоверение']]
              .map(([v, n]) => h('option', { value: v, selected: d.docType === v }, n))),
        ),
        f('Номер документа', 'docNumber', { placeholder: '4510 123456', inputmode: 'numeric' }),
        f('Действителен до', 'docExpiry', { type: 'date' }),
        h('div.field', h('span.label', 'Скан документа'), uploader('docScan', 'Загрузить скан', 'JPG/PNG/PDF до 10 МБ')),
      ),
      selfie: () => h('div',
        h('div.field', h('span.label', 'Селфи с документом'), uploader('selfie', 'Сделать селфи', 'Лицо и документ в кадре, без блика')),
        h('div.note', icon('info'), 'Проверка живости (liveness) выполняется провайдером KYC на бэкенде. Мини-апп только получает результат.'),
      ),
      address: () => h('div',
        f('Адрес', 'address', { placeholder: 'ул. Ленина, 1, кв. 2' }),
        h('div.grid-2', f('Город', 'city', { placeholder: 'Москва' }), f('Индекс', 'zip', { placeholder: '101000', inputmode: 'numeric' })),
      ),
      company: () => h('div',
        f('Название компании', 'company', { placeholder: 'ООО «Пример»' }),
        f('ИНН / Tax ID', 'taxId', { placeholder: '7701234567', inputmode: 'numeric' }),
        h('label.field', h('span.label', 'Страна регистрации'),
          h('select.select', { onChange: (e) => { d.companyCountry = e.target.value; } },
            [['RU', 'Россия'], ['KZ', 'Казахстан'], ['AE', 'ОАЭ'], ['CY', 'Кипр'], ['HK', 'Гонконг']]
              .map(([v, n]) => h('option', { value: v, selected: d.companyCountry === v }, n))),
        ),
        h('div.note', icon('users'), 'Корпоративный уровень снимает лимиты и открывает API для B2B-интеграции (вебхуки, мульти-сит).'),
      ),
    };

    const meta = STEP_META[step];
    const api = openSheet({
      title: meta.title,
      subtitle: meta.sub,
      body: h('div', bodies[step](), errBox),
      foot: [
        h('button.btn.btn-ghost', { onClick: () => api.close() }, 'Отмена'),
        h('button.btn.btn-primary', {
          onClick: () => {
            const errs = validateStep(step, d);
            if (Object.keys(errs).length) {
              mount(errBox, h('div', { style: { marginTop: '12px' } },
                Object.values(errs).map((t) => h('div.note.warn', { style: { marginBottom: '6px' } }, icon('alert'), t))));
              return;
            }
            saveStep(step, d);
            renderKyc();
            toast('Шаг заполнен', meta.title, 'ok');
            api.close();
          },
        }, 'Сохранить'),
      ],
    });
  }

  /* ---------------- подписка ---------------- */

  const planSlot = h('div');

  function fmtLeft(ms) {
    if (ms <= 0) return 'истекла';
    const d = Math.floor(ms / DAY_MS);
    const hrs = Math.floor((ms % DAY_MS) / 3600000);
    if (d >= 1) return `${d} дн · ${hrs} ч`;
    const mins = Math.floor((ms % 3600000) / 60000);
    return `${hrs} ч · ${mins} мин`;
  }

  function statusBanner() {
    const ap = activePlan();
    if (ap) {
      const remaining = planRemainingMs();
      const pct = ap.days ? Math.max(2, Math.min(100, (remaining / (ap.days * DAY_MS)) * 100)) : 0;
      return h('div.sub-status.is-on',
        h('div.sub-status-row',
          h('div.deal-ico', icon('crown', { class: 't-acid' })),
          h('div.row-main',
            h('div.row-title', `Активна: ${ap.name}`,
              ap.bestOffers ? h('span.badge.badge-acid', { style: { marginLeft: '6px' } }, icon('crown'), 'лучшие стаканы') : null),
            h('div.row-sub', `Осталось ${fmtLeft(remaining)} · до ${dateTime(state.profile.planUntil)}`),
          ),
        ),
        h('div.meter', { style: { marginTop: '10px' } }, h('i', { class: pct < 15 ? 'warn' : 'buy', style: { width: `${pct}%` } })),
      );
    }
    const cur = plan();   // тариф был, но срок вышел
    if (cur) {
      return h('div.sub-status.is-off',
        h('div.sub-status-row',
          h('div.deal-ico', icon('clock', { class: 't-sell' })),
          h('div.row-main',
            h('div.row-title', `Подписка истекла: ${cur.name}`),
            h('div.row-sub', 'Оформите тариф заново, чтобы вернуть доступ'),
          ),
        ),
      );
    }
    return h('div.sub-status',
      h('div.sub-status-row',
        h('div.deal-ico', icon('lock', { class: 't-muted' })),
        h('div.row-main',
          h('div.row-title', 'Подписка не оформлена'),
          h('div.row-sub', trialAvailable() ? 'Попробуйте 1 день бесплатно' : 'Выберите тариф ниже'),
        ),
      ),
    );
  }

  function planCard(p) {
    const ap = activePlan();
    const isCurrent = !!ap && ap.id === p.id;
    const isTrial = p.id === 'trial';
    const trialBlocked = isTrial && !trialAvailable();
    const btnLabel = isCurrent ? 'Текущий тариф'
      : trialBlocked ? 'Пробный использован'
      : isTrial ? 'Активировать пробный'
      : 'Оформить';
    return h('div.sub-card', { class: `${isCurrent ? 'is-current' : ''}${p.bestOffers ? ' is-top' : ''}` },
      p.bestOffers ? h('div.sub-ribbon', 'лучшие стаканы') : null,
      h('div.sub-card-head',
        h('div', { style: { minWidth: '0' } },
          h('div.sub-name', p.name, p.bestOffers ? icon('crown', { class: 'sub-crown' }) : null),
          h('div.sub-term', p.term),
        ),
        h('div.sub-price',
          p.price ? h('span.sub-amount', `$${p.price}`) : h('span.sub-amount', 'бесплатно'),
          p.price ? h('span.sub-per', `/ ${p.term}`) : null,
        ),
      ),
      h('ul.sub-perks', p.perks.map((perk) => h('li', icon('check', { class: 't-buy' }), h('span', perk)))),
      h('button.btn.btn-block', {
        class: isCurrent ? 'btn-ghost' : p.bestOffers ? 'btn-primary' : 'btn-soft',
        disabled: isCurrent || trialBlocked,
        onClick: () => {
          if (subscribePlan(p.id)) {
            toast('Подписка оформлена', `${p.name} · ${p.term}`, 'ok');
            renderPlan();
          } else {
            toast('Недоступно', isTrial ? 'Пробный период уже использован' : 'Не удалось оформить', 'warn');
          }
        },
      }, btnLabel),
    );
  }

  function renderPlan() {
    const ap = activePlan();
    mount(planSlot,
      statusBanner(),
      ap ? h('button.btn.btn-ghost.btn-block', {
        style: { marginTop: '8px' },
        onClick: async () => {
          if (await confirmSheet({ title: 'Отменить подписку?', message: `Тариф «${ap.name}» будет отключён, доступ к платным функциям закроется.`, confirmLabel: 'Отменить', danger: true })) {
            cancelPlan(); renderPlan(); toast('Подписка отменена', null, 'warn');
          }
        },
      }, 'Отменить подписку') : null,
      h('div.sub-list', { style: { marginTop: '10px' } }, PLANS.map(planCard)),
      h('div.note', { style: { marginTop: '10px' } }, icon('info'),
        'Лучшие стаканы (метки «★ Лучшая» и «ТОП») доступны только на тарифе «3 месяца». На проде оплата проходит через платёжный провайдер; здесь подписка активируется локально для демонстрации.'),
    );
  }
  renderPlan();

  /* ---------------- security ---------------- */

  const twoFaBtn = h('button.switch', { role: 'switch', 'aria-checked': String(state.profile.twoFa) });
  twoFaBtn.addEventListener('click', () => {
    set('profile', (p) => { p.twoFa = !p.twoFa; });
    twoFaBtn.setAttribute('aria-checked', String(state.profile.twoFa));
    toast(state.profile.twoFa ? '2FA включена' : '2FA отключена', state.profile.twoFa ? 'Подтверждение сделок по TOTP' : null, state.profile.twoFa ? 'ok' : 'warn');
  });

  const security = h('div',
    h('div.panel',
      h('div.switch-row',
        h('div.sr-main', h('div.sr-title', 'Двухфакторная аутентификация'), h('div.sr-sub', 'TOTP-подтверждение при закупках')),
        twoFaBtn,
      ),
      h('button.row', { onClick: openToken },
        h('div.deal-ico', icon('key')),
        h('div.row-main', h('div.row-title', 'API-токен'), h('div.row-sub.mono', mask(state.profile.apiToken, 6))),
        icon('chev', { class: 'row-chev' }),
      ),
      h('button.row', {
        onClick: () => openSheet({
          title: 'Активные сессии',
          body: h('div.panel.panel-flush',
            [
              { d: inTelegram ? 'Telegram Mini App' : 'Браузер (этот)', ip: '—', now: true },
              { d: 'Chrome · macOS', ip: '95.24.·.·', now: false },
              { d: 'API · p2pd_live_···', ip: 'server', now: false },
            ].map((s) => h('div.row',
              h('div.deal-ico', icon(s.now ? 'globe' : 'link')),
              h('div.row-main', h('div.row-title', s.d, s.now ? h('span.badge.badge-buy', 'сейчас') : null), h('div.row-sub.mono', s.ip)),
              !s.now ? h('button.btn.btn-xs.btn-danger', { onClick: (e) => { e.currentTarget.closest('.row').remove(); toast('Сессия завершена', null, 'warn'); } }, 'Выйти') : null,
            )),
          ),
        }),
      },
        h('div.deal-ico', icon('users')),
        h('div.row-main', h('div.row-title', 'Сессии и устройства'), h('div.row-sub', '3 активные сессии')),
        icon('chev', { class: 'row-chev' }),
      ),
    ),
    h('div.panel', { style: { marginTop: '10px' } },
      h('button.row', {
        onClick: async () => {
          if (await confirmSheet({ title: 'Выйти из аккаунта?', message: 'Локальные данные останутся на устройстве. Для полной очистки используйте Настройки → Сбросить данные.', confirmLabel: 'Выйти', danger: true })) {
            if (inTelegram) closeApp(); else toast('Выход выполнен', 'В браузере сессия локальная', 'warn');
          }
        },
      },
        h('div.deal-ico', { style: { color: 'var(--sell)' } }, icon('logout')),
        h('div.row-main', h('div.row-title.t-sell', 'Выйти')),
        icon('chev', { class: 'row-chev' }),
      ),
    ),
  );

  function openToken() {
    const api = openSheet({
      title: 'API-токен',
      subtitle: 'Для серверных интеграций B2B',
      body: h('div',
        h('div.copy-row',
          h('span', state.profile.apiToken),
          h('button.btn.btn-xs.btn-ghost', {
            onClick: async () => {
              try { await navigator.clipboard.writeText(state.profile.apiToken); toast('Скопировано', null, 'ok'); }
              catch { toast('Не удалось скопировать', 'Разрешите доступ к буферу обмена', 'err'); }
            },
          }, icon('copy')),
        ),
        h('div.note', { style: { marginTop: '12px' } }, icon('info'),
          'Токен даёт доступ к REST и WebSocket API: подписка на стаканы, создание ордеров, вебхуки по статусам сделок.'),
      ),
      foot: [
        h('button.btn.btn-ghost', { onClick: () => api.close() }, 'Закрыть'),
        h('button.btn.btn-danger', {
          onClick: () => {
            set('profile', (p) => { p.apiToken = 'p2pd_live_' + Math.random().toString(36).slice(2, 12); });
            toast('Токен перевыпущен', 'Старый больше не действует', 'warn');
            api.close();
          },
        }, icon('refresh'), 'Перевыпустить'),
      ],
    });
  }

  /* ---------------- stats ---------------- */

  function renderStats() {
    const st = state.stats;
    mount(statsSlot, h('div.panel.panel-body',
      h('dl',
        row('Общий объём', `${fmtN(st.volumeUsdt, 2)} USDT`),
        row('Сделок всего', String(st.deals)),
        row('Завершено успешно', `${st.won} (${st.deals ? ((st.won / st.deals) * 100).toFixed(1) : 0}%)`),
        row('Средний спред', `${st.deals ? (st.spreadSum / st.deals).toFixed(2) : '0.00'}%`),
        row('Объём за сутки', `${fmtN(st.dayVolume, 2)} USDT`),
        row('KYC-лимит в сутки', kycInfo().dayLimit === Infinity ? '∞' : `${fmt0(kycInfo().dayLimit)} USDT`),
      ),
    ));
  }

  function row(k, v) { return h('div.kv', h('dt', k), h('dd', v)); }

  unsubs.push(on('kyc', () => { renderKyc(); renderHead(); updateKycBadge(); renderStats(); }));
  unsubs.push(on(['profile', 'stats'], () => { renderHead(); renderStats(); renderPlan(); }));

  renderHead();
  renderKyc();
  updateKycBadge();
  renderStats();

  const regionSlot = h('div');
  function renderRegion() {
    const c = state.region ? COUNTRY[state.region] : null;
    mount(regionSlot, h('div.panel.panel-flush',
      h('button.row', { onClick: () => openRegionSheet({ onPick: renderRegion }) },
        h('div.deal-ico', { style: { fontSize: '18px' } }, c?.flag || '🌐'),
        h('div.row-main',
          h('div.row-title', c ? c.name : 'Регион не выбран'),
          h('div.row-sub', c ? `${CUR[c.cur]?.name || c.cur} · ${c.cur}` : 'Нажмите, чтобы выбрать'),
        ),
        icon('chev', { class: 'row-chev' }),
      ),
    ));
  }
  renderRegion();
  unsubs.push(on('region', renderRegion));

  root.append(
    h('div', { style: { '--i': 0 } }, headSlot),
    title('Регион', 1),
    h('div', { style: { '--i': 1 } }, regionSlot),
    title('KYC-верификация', 1, kycBadge),
    h('div', { style: { '--i': 2 } }, kycSlot),
    title('Подписка', 3),
    h('div', { style: { '--i': 4 } }, planSlot),
    title('Безопасность', 5),
    h('div', { style: { '--i': 6 } }, security),
    title('Статистика', 7),
    h('div', { style: { '--i': 8 } }, statsSlot),
    h('div.foot-note', inTelegram ? 'Запущено как Telegram Mini App' : 'Веб-версия'),
  );

  return { node: root, destroy: () => unsubs.forEach((u) => u()) };
}
