export interface CalendarItem {
  name: string;
  phone: string;
  email: string;
  purposeLabel: string;
  date: string; // YYYY-MM-DD IST
  time: string; // HH:MM IST
  summary?: string;
}

const esc = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");

const fmtUtc = (ms: number) =>
  new Date(ms).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";

function startMs(b: CalendarItem) {
  const [y, mo, d] = b.date.split("-").map(Number);
  const [h, mi] = b.time.split(":").map(Number);
  return Date.UTC(y, mo - 1, d, h, mi) - 330 * 60_000; // IST = UTC+05:30
}

const title = (b: CalendarItem) => `FinServe callback: ${b.purposeLabel}`;
const body = (b: CalendarItem) =>
  `A FinServe loan specialist will call you on +91 ${b.phone}.\nPurpose: ${b.purposeLabel}${
    b.summary ? `\n\n${b.summary}` : ""
  }`;

export function buildIcs(b: CalendarItem): string {
  const start = startMs(b);
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//FinServe//Callback Bot//EN",
    "BEGIN:VEVENT",
    `UID:${Date.now()}@finserve-bot`,
    `DTSTAMP:${fmtUtc(Date.now())}`,
    `DTSTART:${fmtUtc(start)}`,
    `DTEND:${fmtUtc(start + 30 * 60_000)}`,
    `SUMMARY:${esc(title(b))}`,
    `DESCRIPTION:${esc(body(b))}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

export function downloadIcs(b: CalendarItem) {
  const blob = new Blob([buildIcs(b)], { type: "text/calendar" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "finserve-callback.ics";
  a.click();
  URL.revokeObjectURL(url);
}

/** "Add to Google Calendar" link for the customer (no login or API needed). */
export function googleCalendarLink(b: CalendarItem): string {
  const start = startMs(b);
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: title(b),
    dates: `${fmtUtc(start)}/${fmtUtc(start + 30 * 60_000)}`,
    details: body(b),
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
