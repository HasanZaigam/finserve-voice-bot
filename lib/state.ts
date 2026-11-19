// Conversation state + deterministic validation.
// The LLM extracts values; this file decides whether they are acceptable.

export type Purpose =
  | "emi_query"
  | "payment_plan"
  | "new_loan"
  | "talk_to_agent"
  | "other";

export const PURPOSE_LABEL: Record<Purpose, string> = {
  emi_query: "EMI query",
  payment_plan: "Payment arrangement",
  new_loan: "New loan enquiry",
  talk_to_agent: "Speak to an agent",
  other: "Other enquiry",
};

export interface BotState {
  name?: string;
  phone?: string;
  email?: string;
  purpose?: Purpose;
  details: Record<string, string>;
  detailsComplete: boolean;
  date?: string; // YYYY-MM-DD (IST)
  time?: string; // HH:MM 24h (IST)
  attempts: Record<string, number>;
}

export interface Extracted {
  name?: string;
  phone?: string;
  email?: string;
  purpose?: Purpose;
  details?: Record<string, string>;
  details_complete?: boolean;
  date?: string;
  time?: string;
}

export const emptyState = (): BotState => ({
  details: {},
  detailsComplete: false,
  attempts: {},
});

const IST = "Asia/Kolkata";

export function todayIST(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(new Date());
}

export function nowHHMM(): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: IST,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

export function nowISTLabel(): string {
  return new Date().toLocaleString("en-IN", {
    timeZone: IST,
    dateStyle: "full",
    timeStyle: "short",
  });
}

function addDays(ymd: string, n: number): string {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function cleanPhone(v: string): string {
  let d = v.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return d;
}

type Field = "name" | "phone" | "email" | "date" | "time";

const validators: Record<Field, (v: string) => string | null> = {
  name: (v) =>
    /^[\p{L} .'-]{2,60}$/u.test(v.trim()) ? null : "doesn't look like a valid name",
  phone: (v) =>
    /^[6-9]\d{9}$/.test(cleanPhone(v))
      ? null
      : "is not a valid 10-digit Indian mobile number",
  email: (v) =>
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) ? null : "is not a valid email address",
  date: (v) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return "could not be understood as a date";
    const today = todayIST();
    if (v < today) return "is in the past";
    if (v > addDays(today, 30)) return "is more than 30 days away";
    return null;
  },
  time: (v) => {
    if (!/^\d{2}:\d{2}$/.test(v)) return "could not be understood as a time";
    const [h, m] = v.split(":").map(Number);
    if (h < 8 || h > 20 || (h === 20 && m > 30))
      return "is outside our calling hours (8 AM to 9 PM)";
    return null;
  },
};

export function mergeExtracted(prev: BotState, ex: Extracted) {
  const s: BotState = {
    ...prev,
    details: { ...prev.details },
    attempts: { ...prev.attempts },
  };
  const errors: string[] = [];

  const fields: Field[] = ["name", "phone", "email", "date", "time"];
  for (const f of fields) {
    const raw = ex[f];
    if (!raw) continue;
    const err = validators[f](String(raw));
    if (err) {
      s.attempts[f] = (s.attempts[f] ?? 0) + 1;
      errors.push(`${f} "${raw}" ${err} (failed attempt ${s.attempts[f]})`);
      continue;
    }
    s[f] =
      f === "phone"
        ? cleanPhone(raw)
        : f === "email"
          ? raw.trim().toLowerCase()
          : raw.trim();
  }

  // A slot later today must still be in the future.
  if (s.date && s.time && s.date === todayIST() && s.time <= nowHHMM()) {
    errors.push(`time ${s.time} today has already passed`);
    s.time = undefined;
  }

  if (ex.purpose) s.purpose = ex.purpose;
  if (ex.details) {
    for (const [k, v] of Object.entries(ex.details)) {
      if (v && String(v).trim()) s.details[k] = String(v).trim();
    }
  }
  if (ex.details_complete) s.detailsComplete = true;
  if (s.purpose === "talk_to_agent") s.detailsComplete = true;

  return { state: s, errors };
}

export function missingFields(s: BotState): string[] {
  const m: string[] = [];
  if (!s.name) m.push("full name");
  if (!s.phone) m.push("mobile number");
  if (!s.email) m.push("email address");
  if (!s.purpose) m.push("purpose of enquiry");
  else if (!s.detailsComplete)
    m.push(`follow-up questions for ${PURPOSE_LABEL[s.purpose]}`);
  if (!s.date) m.push("preferred callback date");
  if (!s.time) m.push("preferred callback time");
  return m;
}

export function prettyDate(ymd?: string): string {
  if (!ymd) return "";
  return new Date(ymd + "T00:00:00").toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function prettyTime(hhmm?: string): string {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}
