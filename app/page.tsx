"use client";

import { useEffect, useRef, useState } from "react";
import { AGENT_NAME, GREETING } from "../lib/prompt";
import {
  BotState,
  emptyState,
  PURPOSE_LABEL,
  prettyDate,
  prettyTime,
} from "../lib/state";
import { CalendarItem, downloadIcs, googleCalendarLink } from "../lib/ics";

type Msg = { role: "user" | "assistant"; content: string };
type Mode = "voice" | "chat";
type CallStatus = "idle" | "connecting" | "live" | "ended";

interface Lead {
  name?: string;
  phone?: string;
  phoneConfirming?: boolean;
  email?: string;
  emailConfirming?: boolean;
  purposeLabel?: string;
  details?: [string, string][];
  date?: string;
  time?: string;
}

interface BookingView extends CalendarItem {
  details: string;
  status: string;
  eventLink?: string;
}

const DETAIL_LABELS: Record<string, string> = {
  loan_last4: "Loan (last 4)",
  issue_type: "Issue",
  expected_amount: "Expected amount",
  charged_amount: "Charged amount",
  preferred_emi_date: "Preferred EMI date",
  payment_date: "Payment date",
  payment_mode: "Payment mode",
  reason: "Reason",
  expected_pay_by: "Can pay by",
  loan_type: "Loan type",
  loan_amount: "Amount",
  employment_type: "Employment",
  topic: "Topic",
  description: "Description",
};
const labelOf = (k: string) =>
  DETAIL_LABELS[k] ?? k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

const fmtPhone = (p?: string) => (p ? `+91 ${p.slice(0, 5)} ${p.slice(5)}` : undefined);

/** Pull our tool results (kind: "finserve_*") out of any Vapi client message. */
function findResults(obj: unknown, out: any[] = [], depth = 0): any[] {
  if (obj == null || depth > 10) return out;
  if (typeof obj === "string") {
    if (obj.includes('"kind":"finserve_')) {
      try {
        const parsed = JSON.parse(obj);
        if (parsed?.kind) out.push(parsed);
      } catch {
        /* not JSON */
      }
    }
    return out;
  }
  if (typeof obj === "object") {
    const o = obj as Record<string, unknown>;
    if (typeof o.kind === "string" && o.kind.startsWith("finserve_")) {
      out.push(o);
      return out;
    }
    for (const v of Object.values(o)) findResults(v, out, depth + 1);
  }
  return out;
}

function leadFromState(s: BotState): Lead {
  const pPhone = s.pending.find((p) => p.field === "phone");
  const pEmail = s.pending.find((p) => p.field === "email");
  return {
    name: s.name,
    phone: s.phone ?? pPhone?.value,
    phoneConfirming: !s.phone && !!pPhone,
    email: s.email ?? pEmail?.value,
    emailConfirming: !s.email && !!pEmail,
    purposeLabel: s.purpose ? PURPOSE_LABEL[s.purpose] : undefined,
    details: Object.entries(s.details).map(([k, v]) => [labelOf(k), v]),
    date: s.date,
    time: s.time,
  };
}

export default function Home() {
  const [mode, setMode] = useState<Mode>("voice");
  const [lead, setLead] = useState<Lead>({});
  const [booking, setBooking] = useState<BookingView | null>(null);

  // chat
  const [messages, setMessages] = useState<Msg[]>([{ role: "assistant", content: GREETING }]);
  const [botState, setBotState] = useState<BotState>(emptyState());
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  // voice
  const [lines, setLines] = useState<Msg[]>([]);
  const [partial, setPartial] = useState<{ role: Msg["role"]; text: string } | null>(null);
  const [status, setStatus] = useState<CallStatus>("idle");
  const [speaking, setSpeaking] = useState(false);
  const [volume, setVolume] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [notice, setNotice] = useState("");

  const vapiRef = useRef<any>(null);
  const messagesRef = useRef(messages);
  const botStateRef = useRef(botState);
  const endRef = useRef<HTMLDivElement>(null);
  messagesRef.current = messages;
  botStateRef.current = botState;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, lines, partial, loading]);

  useEffect(() => {
    if (status !== "live") return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [status]);

  useEffect(() => () => vapiRef.current?.stop?.(), []);

  /* ---------------- voice (Vapi) ---------------- */

  function applyResult(r: any) {
    if (r.kind === "finserve_details") {
      const f = r.fields ?? {};
      setLead((l) => ({
        ...l,
        ...(f.name?.ok ? { name: f.name.value } : {}),
        ...(f.phone?.ok ? { phone: f.phone.value, phoneConfirming: false } : {}),
        ...(f.email?.ok ? { email: f.email.value, emailConfirming: false } : {}),
        ...(f.purpose?.ok ? { purposeLabel: f.purpose.label } : {}),
      }));
    } else if (r.kind === "finserve_availability" && r.ok) {
      setLead((l) => ({ ...l, date: r.date, ...(r.time ? { time: r.time } : {}) }));
    } else if (r.kind === "finserve_booking" && r.booked && r.booking) {
      const b = r.booking;
      setLead((l) => ({
        ...l,
        name: b.name,
        phone: b.phone,
        email: b.email,
        purposeLabel: b.purposeLabel,
        details: b.details ? [["Details", b.details]] : l.details,
        date: b.date,
        time: b.time,
      }));
      setBooking({
        name: b.name,
        phone: b.phone,
        email: b.email,
        purposeLabel: b.purposeLabel,
        date: b.date,
        time: b.time,
        summary: b.summary,
        details: b.details,
        status: b.status,
        eventLink: b.eventLink,
      });
    }
  }

  function onVapiMessage(m: any) {
    if (m?.type === "transcript") {
      const role: Msg["role"] = m.role === "assistant" ? "assistant" : "user";
      const text: string = (m.transcript ?? "").trim();
      if (m.transcriptType === "final" && text) {
        setPartial(null);
        setLines((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === role) {
            if (last.content.endsWith(text)) return prev; // duplicate event
            return [...prev.slice(0, -1), { role, content: `${last.content} ${text}` }];
          }
          return [...prev, { role, content: text }];
        });
      } else if (text) {
        setPartial({ role, text });
      }
    }
    for (const r of findResults(m)) applyResult(r);
  }

  async function startCall() {
    const key = process.env.NEXT_PUBLIC_VAPI_PUBLIC_KEY;
    if (!key) {
      setNotice("Voice is not configured: NEXT_PUBLIC_VAPI_PUBLIC_KEY is missing.");
      return;
    }
    setNotice("");
    setLines([]);
    setPartial(null);
    setLead({});
    setBooking(null);
    setSeconds(0);
    setStatus("connecting");
    try {
      const [{ default: Vapi }, cfg] = await Promise.all([
        import("@vapi-ai/web"),
        fetch("/api/vapi/config").then((r) => r.json()),
      ]);
      const vapi = new Vapi(key);
      vapiRef.current = vapi;
      vapi.on("call-start", () => setStatus("live"));
      vapi.on("call-end", () => {
        setStatus("ended");
        setSpeaking(false);
        setVolume(0);
        setPartial(null);
      });
      vapi.on("speech-start", () => setSpeaking(true));
      vapi.on("speech-end", () => setSpeaking(false));
      vapi.on("volume-level", (v: number) => setVolume(v));
      vapi.on("message", onVapiMessage);
      vapi.on("error", (e: any) => {
        console.error("Vapi error", e);
        const msg = JSON.stringify(e ?? "");
        setNotice(
          /permission|NotAllowed/i.test(msg)
            ? "Microphone access was blocked. Allow it in the address bar and try again."
            : "The call ran into a problem. Please try again.",
        );
        setStatus((s) => (s === "connecting" ? "idle" : s));
      });
      await vapi.start(cfg.assistant);
    } catch (e) {
      console.error(e);
      setNotice("Couldn't start the call. Check your connection and microphone, then try again.");
      setStatus("idle");
    }
  }

  function endCall() {
    vapiRef.current?.stop?.();
    setStatus("ended");
  }

  /* ---------------- chat ---------------- */

  async function send(text: string) {
    const t = text.trim();
    if (!t || loading || booking) return;
    const next: Msg[] = [...messagesRef.current, { role: "user", content: t }];
    setMessages(next);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next, state: botStateRef.current }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setMessages([...next, { role: "assistant", content: data.reply }]);
      const s: BotState = data.state;
      setBotState(s);
      setLead(leadFromState(s));
      if (data.done && s.booking) {
        setBooking({
          name: s.name!,
          phone: s.phone!,
          email: s.email!,
          purposeLabel: PURPOSE_LABEL[s.purpose!],
          date: s.date!,
          time: s.time!,
          summary: data.summary,
          details: Object.entries(s.details)
            .map(([k, v]) => `${labelOf(k)}: ${v}`)
            .join(" · "),
          status: s.booking.status,
          eventLink: s.booking.eventLink,
        });
      }
    } catch {
      setMessages([
        ...next,
        { role: "assistant", content: "Sorry, I'm having trouble connecting right now. Could you please say that again?" },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function resetAll() {
    vapiRef.current?.stop?.();
    setStatus("idle");
    setLines([]);
    setPartial(null);
    setMessages([{ role: "assistant", content: GREETING }]);
    setBotState(emptyState());
    setLead({});
    setBooking(null);
    setNotice("");
    setSeconds(0);
  }

  function switchMode(m: Mode) {
    if (m === mode || status === "live" || status === "connecting") return;
    resetAll();
    setMode(m);
  }

  /* ---------------- view ---------------- */

  const steps = [
    { label: "Caller details", done: !!(lead.name && lead.phone && lead.email && !lead.phoneConfirming && !lead.emailConfirming) },
    { label: "Enquiry", done: !!lead.purposeLabel },
    { label: "Schedule", done: !!(lead.date && lead.time) },
    { label: "Confirmed", done: !!booking },
  ];
  const current = steps.findIndex((s) => !s.done);

  const rows: [string, string | undefined, boolean?][] = [
    ["Name", lead.name],
    ["Mobile", fmtPhone(lead.phone), lead.phoneConfirming],
    ["Email", lead.email, lead.emailConfirming],
    ["Purpose", lead.purposeLabel],
    ...((lead.details ?? []).map(([k, v]) => [k, v]) as [string, string][]),
    ["Callback", lead.date ? `${prettyDate(lead.date)}${lead.time ? ` · ${prettyTime(lead.time)}` : ""}` : undefined],
  ];

  const callLabel =
    status === "connecting"
      ? "Connecting…"
      : status === "live"
        ? speaking
          ? `${AGENT_NAME} is speaking`
          : "Listening…"
        : status === "ended"
          ? "Call ended"
          : "Ready to take your call";
  const mmss = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const transcript = mode === "voice" ? lines : messages;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="logo">F</div>
          <div>
            <div className="brand-name">FinServe Finance</div>
            <div className="brand-sub">Customer Care · AI Voice Desk</div>
          </div>
        </div>
        <div className="chips">
          <span className="chip">Claude</span>
          <span className="chip">Vapi Voice</span>
          <span className="chip">Google Calendar</span>
        </div>
      </header>

      <main className="layout">
        <section className="card console">
          <div className="tabs" role="tablist">
            {(["voice", "chat"] as Mode[]).map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                className={`tab ${mode === m ? "active" : ""}`}
                onClick={() => switchMode(m)}
                disabled={status === "live" || status === "connecting"}
              >
                {m === "voice" ? "Voice call" : "Chat"}
              </button>
            ))}
            <button className="link-btn" onClick={resetAll}>
              Start over
            </button>
          </div>

          {mode === "voice" && (
            <div className="callhead">
              <div
                className={`orb ${status} ${speaking ? "speaking" : ""}`}
                style={{ ["--lvl" as string]: String(Math.min(1, volume * 2.2)) }}
              >
                <div className="orb-core">{AGENT_NAME[0]}</div>
              </div>
              <div className="agent-name">{AGENT_NAME}</div>
              <div className="agent-role">AI customer care agent</div>
              <div className={`call-status ${status}`}>
                {status === "live" && <span className="dot" />}
                {callLabel}
                {(status === "live" || status === "ended") && <span className="timer">{mmss}</span>}
              </div>
              {status === "live" || status === "connecting" ? (
                <button className="call-btn end" onClick={endCall}>
                  <PhoneIcon /> End call
                </button>
              ) : (
                <button className="call-btn start" onClick={startCall}>
                  <PhoneIcon /> {status === "ended" ? "Call again" : "Call customer care"}
                </button>
              )}
              {notice && <div className="notice">{notice}</div>}
            </div>
          )}

          <div className={`transcript ${mode}`}>
            {mode === "voice" && transcript.length === 0 && !partial && (
              <div className="empty">
                Press <b>Call customer care</b> to talk to {AGENT_NAME}. Use Chrome and allow the
                microphone. The live transcript appears here.
              </div>
            )}
            {transcript.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                <div className="who">{m.role === "assistant" ? AGENT_NAME : "You"}</div>
                <div className="bubble">{m.content}</div>
              </div>
            ))}
            {mode === "voice" && partial && (
              <div className={`msg ${partial.role} partial`}>
                <div className="who">{partial.role === "assistant" ? AGENT_NAME : "You"}</div>
                <div className="bubble">{partial.text}</div>
              </div>
            )}
            {mode === "chat" && loading && (
              <div className="msg assistant">
                <div className="who">{AGENT_NAME}</div>
                <div className="bubble typing">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            )}
            <div ref={endRef} />
          </div>

          {mode === "chat" && (
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
              }}
            >
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={booking ? "Callback booked. Start over for a new enquiry" : "Type your reply…"}
                disabled={!!booking || loading}
                autoFocus
              />
              <button className="send-btn" disabled={!!booking || loading || !input.trim()}>
                Send
              </button>
            </form>
          )}
        </section>

        <aside className="side">
          <div className="card">
            <ol className="stepper">
              {steps.map((s, i) => (
                <li key={s.label} className={s.done ? "done" : i === current ? "current" : ""}>
                  <span className="step-dot">{s.done ? "✓" : i + 1}</span>
                  <span>{s.label}</span>
                </li>
              ))}
            </ol>
          </div>

          {booking ? (
            <div className="card booking">
              <div className="booked-badge">✓ Callback booked</div>
              <div className="booked-when">
                <div className="booked-date">{prettyDate(booking.date)}</div>
                <div className="booked-time">{prettyTime(booking.time)} IST</div>
              </div>
              <dl className="rows">
                <Row k="Name" v={booking.name} />
                <Row k="Mobile" v={fmtPhone(booking.phone)} />
                <Row k="Email" v={booking.email} />
                <Row k="Purpose" v={booking.purposeLabel} />
                {booking.details && <Row k="Details" v={booking.details} />}
              </dl>
              {booking.summary && (
                <div className="handover">
                  <div className="handover-label">Handover note for the specialist</div>
                  <p>{booking.summary}</p>
                </div>
              )}
              <div className={`sync ${booking.status}`}>
                {booking.status === "booked"
                  ? "Added to the specialists' Google Calendar"
                  : booking.status === "calendar_error"
                    ? "Calendar sync failed, so the booking is saved here only"
                    : "Calendar not connected, so the booking is saved here only"}
              </div>
              <div className="actions">
                <a className="btn primary" href={googleCalendarLink(booking)} target="_blank" rel="noreferrer">
                  Add to my Google Calendar
                </a>
                <button className="btn" onClick={() => downloadIcs(booking)}>
                  Download .ics
                </button>
              </div>
            </div>
          ) : (
            <div className="card">
              <div className="card-title">Live call record</div>
              <dl className="rows">
                {rows.map(([k, v, confirming]) => (
                  <Row key={k} k={k} v={v} confirming={confirming} />
                ))}
              </dl>
              <p className="hint">
                Every value is checked in code before it&apos;s saved. Mobile numbers and emails are
                read back to the caller for confirmation.
              </p>
            </div>
          )}
        </aside>
      </main>

      <footer className="foot">
        Demo project · Claude (Anthropic) for conversation, Vapi for real-time voice, Google Calendar
        for scheduling
      </footer>
    </div>
  );
}

function Row({ k, v, confirming }: { k: string; v?: string; confirming?: boolean }) {
  return (
    <div className="row">
      <dt>{k}</dt>
      <dd className={v ? "" : "pending"}>
        {v ?? "—"}
        {v && confirming && <span className="confirming">confirming</span>}
      </dd>
    </div>
  );
}

function PhoneIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" />
    </svg>
  );
}
