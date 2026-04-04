/** Format a phone number to E.164 */
export function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

/** Format a date string to YYYY-MM-DD */
export function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

/** Sleep for ms milliseconds */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Create a logger with a namespace prefix */
export function createLogger(namespace: string) {
  return {
    info: (msg: string, ...args: unknown[]) => console.log(`[${namespace}] ${msg}`, ...args),
    warn: (msg: string, ...args: unknown[]) => console.warn(`[${namespace}] ${msg}`, ...args),
    error: (msg: string, ...args: unknown[]) => console.error(`[${namespace}] ${msg}`, ...args),
  };
}
