export type NormalizedPhone = {
  value: string;
  digits: string;
  masked: string;
};

/**
 * Performs a plausibility check only. It deliberately does not send an SMS or
 * claim that the person registering owns the number.
 */
export function normalizePhone(input: string): NormalizedPhone | null {
  const raw = input.trim();
  if (!raw || !/^\+?[\d\s().-]+$/.test(raw)) return null;

  const hasCountryPrefix = raw.startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  if (/^(\d)\1+$/.test(digits)) return null;
  if (/^(?:0123456789|1234567890|9876543210)$/.test(digits)) return null;
  if (/^(?:1234567|7654321|0000000)/.test(digits)) return null;
  if (new Set(digits).size < 3) return null;

  const value = hasCountryPrefix ? `+${digits}` : digits;
  return {
    value,
    digits,
    masked: `${hasCountryPrefix ? "+" : ""}${digits.slice(0, 3)}****${digits.slice(-3)}`,
  };
}

