import { BotState, PURPOSE_LABEL } from "./state";

const esc = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");

const fmt = (ms: number) =>
  new Date(ms).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";

export function buildIcs(s: BotState, summary: string): string {
  const [y, mo, d] = s.date!.split("-").map(Number);
  const [h, mi] = s.time!.split(":").map(Number);
  // IST is UTC+05:30
  const start = Date.UTC(y, mo - 1, d, h, mi) - 330 * 60_000;
  const end = start + 30 * 60_000;
  const purpose = s.purpose ? PURPOSE_LABEL[s.purpose] : "Enquiry";

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//FinServe//Callback Bot//EN",
    "BEGIN:VEVENT",
    `UID:${Date.now()}@finserve-bot`,
    `DTSTAMP:${fmt(Date.now())}`,
    `DTSTART:${fmt(start)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${esc(`FinServe callback: ${purpose} (${s.name})`)}`,
    `DESCRIPTION:${esc(
      `Customer: ${s.name}\nPhone: ${s.phone}\nEmail: ${s.email}\nPurpose: ${purpose}\n\n${summary}`,
    )}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

export function downloadIcs(s: BotState, summary: string) {
  const blob = new Blob([buildIcs(s, summary)], { type: "text/calendar" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "finserve-callback.ics";
  a.click();
  URL.revokeObjectURL(url);
}
