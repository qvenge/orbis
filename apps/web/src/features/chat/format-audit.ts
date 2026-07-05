// Леджер 1c: approve одиночного payload звучит «batch: операций — 1» → сгладить,
// чтобы UX не показывал «batch» для одной операции (рендерер сглаживает формулировку).
export function smoothAuditText(text: string): string {
  if (/^batch:\s*операций\s*[—-]\s*1$/i.test(text.trim())) return 'Операция выполнена';
  return text;
}
