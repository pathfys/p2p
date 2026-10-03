/** KYC state machine. Gates trading; levels raise the daily limit. */
import { state, set, KYC_LEVELS } from '../core/store.js';
import { log } from './logs.js';
import { toast } from '../ui/toast.js';

export const STEP_ORDER = ['personal', 'document', 'selfie', 'address', 'company'];

export const STEP_META = {
  personal: { title: 'Личные данные',   sub: 'ФИО, дата рождения, страна',            icon: 'user' },
  document: { title: 'Документ',        sub: 'Паспорт или ID + скан',                  icon: 'doc' },
  selfie:   { title: 'Селфи с документом', sub: 'Живая проверка лица',                 icon: 'camera' },
  address:  { title: 'Адрес',           sub: 'Подтверждение места проживания',         icon: 'globe' },
  company:  { title: 'Компания',        sub: 'Для корпоративного уровня (B2B)',        icon: 'users' },
};

/** Which steps a target level needs. */
export const stepsFor = (level) => KYC_LEVELS[level]?.needs || [];

export function validateStep(step, d) {
  const e = {};
  if (step === 'personal') {
    if (!d.firstName?.trim()) e.firstName = 'Укажите имя';
    if (!d.lastName?.trim()) e.lastName = 'Укажите фамилию';
    if (!d.birthDate) e.birthDate = 'Укажите дату рождения';
    else {
      const age = (Date.now() - new Date(d.birthDate)) / (365.25 * 864e5);
      if (age < 18) e.birthDate = 'Доступно с 18 лет';
      if (age > 120 || Number.isNaN(age)) e.birthDate = 'Некорректная дата';
    }
  }
  if (step === 'document') {
    if (!d.docNumber?.trim() || d.docNumber.replace(/\D/g, '').length < 6) e.docNumber = 'Некорректный номер документа';
    if (!d.docExpiry) e.docExpiry = 'Укажите срок действия';
    else if (new Date(d.docExpiry) < new Date()) e.docExpiry = 'Документ просрочен';
    if (!d.docScan) e.docScan = 'Загрузите скан документа';
  }
  if (step === 'selfie' && !d.selfie) e.selfie = 'Нужно селфи с документом';
  if (step === 'address') {
    if (!d.address?.trim()) e.address = 'Укажите адрес';
    if (!d.city?.trim()) e.city = 'Укажите город';
  }
  if (step === 'company') {
    if (!d.company?.trim()) e.company = 'Укажите название компании';
    if (!d.taxId?.trim()) e.taxId = 'Укажите ИНН / Tax ID';
  }
  return e;
}

export function saveStep(step, patch) {
  set('kyc', (k) => {
    Object.assign(k.data, patch);
    const errs = validateStep(step, k.data);
    k.steps[step] = Object.keys(errs).length === 0;
    if (k.status === 'none') k.status = 'draft';
  });
  return state.kyc.steps[step];
}

export function canSubmit(targetLevel) {
  return stepsFor(targetLevel).every((s) => state.kyc.steps[s]);
}

export function submit(targetLevel) {
  if (!canSubmit(targetLevel)) {
    toast('Не хватает данных', 'Заполните все шаги уровня', 'err');
    return false;
  }
  set('kyc', (k) => {
    k.status = 'pending';
    k.submittedAt = Date.now();
    k.pendingLevel = targetLevel;
    k.rejectReason = null;
  });
  log('info', 'sys', `KYC заявка отправлена · уровень <b>${targetLevel}</b>`);
  toast('Заявка отправлена', 'Проверка занимает до 10 минут', 'ok');

  // the backend will emit the real decision; simulate the review here
  setTimeout(() => {
    if (state.kyc.status !== 'pending') return;
    const d = state.kyc.data;
    const suspicious = /test|тест|qwerty|0000/i.test(`${d.firstName}${d.lastName}${d.docNumber}`);
    if (suspicious) {
      set('kyc', (k) => { k.status = 'rejected'; k.reviewedAt = Date.now(); k.rejectReason = 'Данные не прошли автопроверку: подозрительные значения в полях'; });
      log('warn', 'sys', 'KYC <b>отклонён</b> автопроверкой');
      toast('KYC отклонён', state.kyc.rejectReason, 'err', 5200);
    } else {
      set('kyc', (k) => { k.status = 'approved'; k.level = targetLevel; k.reviewedAt = Date.now(); });
      log('info', 'sys', `KYC <b>одобрен</b> · уровень ${targetLevel} · лимит ${KYC_LEVELS[targetLevel].dayLimit} USDT/сутки`);
      toast('KYC одобрен', `Уровень ${targetLevel} · торговля разблокирована`, 'ok', 4600);
    }
  }, 9000);
  return true;
}

export function reset() {
  set('kyc', (k) => {
    k.status = 'none'; k.level = 0; k.submittedAt = null; k.reviewedAt = null; k.rejectReason = null;
    k.steps = { personal: false, document: false, selfie: false, address: false, company: false };
  });
}
