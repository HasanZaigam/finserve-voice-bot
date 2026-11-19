"use client";

import { useEffect, useRef, useState } from "react";
import { GREETING } from "../lib/prompt";
import {
  BotState,
  emptyState,
  PURPOSE_LABEL,
  prettyDate,
  prettyTime,
} from "../lib/state";
import { downloadIcs } from "../lib/ics";

type Msg = { role: "user" | "assistant"; content: string };

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

const label = (k: string) =>
  DETAIL_LABELS[k] ?? k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export default function Home() {
  const [messages, setMessages] = useState<Msg[]>([
    { role: "assistant", content: GREETING },
  ]);
  const [state, setState] = useState<BotState>(emptyState());
  const [done, setDone] = useState(false);
  const [summary, setSummary] = useState("");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [voice, setVoice] = useState(false);
  const [listening, setListening] = useState(false);
  const [notice, setNotice] = useState("");

  const messagesRef = useRef(messages);
  const stateRef = useRef(state);
  const voiceRef = useRef(false);
  const doneRef = useRef(false);
  const recRef = useRef<any>(null);
  const missRef = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);

  messagesRef.current = messages;
  stateRef.current = state;
  doneRef.current = done;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  useEffect(() => {
    // Some browsers load voices asynchronously.
    window.speechSynthesis?.getVoices();
  }, []);

  function speak(text: string, listenAfter: boolean) {
    if (!voiceRef.current || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-IN";
    u.rate = 1.03;
    const v =
      window.speechSynthesis.getVoices().find((x) => x.lang === "en-IN") ??
      window.speechSynthesis.getVoices().find((x) => x.lang.startsWith("en"));
    if (v) u.voice = v;
    u.onend = () => {
      if (listenAfter && voiceRef.current && !doneRef.current) startListening();
    };
    window.speechSynthesis.speak(u);
  }

  function startListening() {
    const SR =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setNotice("Voice input needs Chrome or Edge. You can still type.");
      return;
    }
    recRef.current?.abort?.();
    const rec = new SR();
    rec.lang = "en-IN";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e: any) => {
      missRef.current = 0;
      const transcript = e.results[0][0].transcript as string;
      send(transcript);
    };
    rec.onerror = (e: any) => {
      setListening(false);
      if (e.error === "no-speech" && voiceRef.current && missRef.current < 2) {
        missRef.current += 1;
        speak("Sorry, I didn't catch that. Could you say it again?", true);
      } else if (e.error === "not-allowed") {
        setNotice("Microphone permission was blocked. Allow it and try again.");
      }
    };
    rec.onend = () => setListening(false);
    recRef.current = rec;
    setListening(true);
    rec.start();
  }

  async function send(text: string) {
    const t = text.trim();
    if (!t || doneRef.current) return;
    setNotice("");
    const next: Msg[] = [...messagesRef.current, { role: "user", content: t }];
    messagesRef.current = next;
    setMessages(next);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next, state: stateRef.current }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const withReply: Msg[] = [...next, { role: "assistant", content: data.reply }];
      messagesRef.current = withReply;
      setMessages(withReply);
      setState(data.state);
      stateRef.current = data.state;
      if (data.done) {
        setDone(true);
        doneRef.current = true;
        setSummary(data.summary);
      }
      speak(data.reply, !data.done);
    } catch {
      const fallback =
        "Sorry, I'm having trouble connecting right now. Could you please repeat that?";
      const withFallback: Msg[] = [...next, { role: "assistant", content: fallback }];
      messagesRef.current = withFallback;
      setMessages(withFallback);
      speak(fallback, true);
    } finally {
      setLoading(false);
    }
  }

  function toggleCall() {
    if (voiceRef.current) {
      voiceRef.current = false;
      setVoice(false);
      recRef.current?.abort?.();
      window.speechSynthesis?.cancel();
      setListening(false);
      return;
    }
    voiceRef.current = true;
    setVoice(true);
    const last = messagesRef.current[messagesRef.current.length - 1];
    if (last?.role === "assistant") speak(last.content, !doneRef.current);
  }

  function restart() {
    recRef.current?.abort?.();
    window.speechSynthesis?.cancel();
    voiceRef.current = false;
    setVoice(false);
    setListening(false);
    setMessages([{ role: "assistant", content: GREETING }]);
    setState(emptyState());
    setDone(false);
    setSummary("");
    setNotice("");
  }

  const rows: [string, string | undefined][] = [
    ["Name", state.name],
    ["Mobile", state.phone],
    ["Email", state.email],
    ["Purpose", state.purpose ? PURPOSE_LABEL[state.purpose] : undefined],
    ...Object.entries(state.details).map(
      ([k, v]) => [label(k), v] as [string, string],
    ),
    ["Callback date", prettyDate(state.date) || undefined],
    ["Callback time", prettyTime(state.time) || undefined],
  ];

  return (
    <main className="wrap">
      <header className="top">
        <div>
          <h1>FinServe Finance</h1>
          <p className="sub">Inbound customer line · AI assistant Aria</p>
        </div>
        <div className="actions">
          <button className={voice ? "btn danger" : "btn primary"} onClick={toggleCall}>
            {voice ? "End voice call" : "Start voice call"}
          </button>
          <button className="btn" onClick={restart}>
            New conversation
          </button>
        </div>
      </header>

      <div className="grid">
        <section className="chat">
          <div className="status">
            {voice ? (
              listening ? (
                <span className="pill live">● Listening…</span>
              ) : loading ? (
                <span className="pill">Thinking…</span>
              ) : (
                <span className="pill">On call</span>
              )
            ) : (
              <span className="pill muted">Text mode</span>
            )}
            {notice && <span className="notice">{notice}</span>}
          </div>

          <div className="messages">
            {messages.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                <div className="bubble">{m.content}</div>
              </div>
            ))}
            {loading && (
              <div className="msg assistant">
                <div className="bubble typing">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            )}
            <div ref={endRef} />
          </div>

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
              placeholder={done ? "Conversation complete" : "Type your reply…"}
              disabled={done || loading}
            />
            {voice && !done && (
              <button
                type="button"
                className="btn"
                onClick={startListening}
                disabled={listening || loading}
                aria-label="Speak"
              >
                🎤
              </button>
            )}
            <button className="btn primary" disabled={done || loading || !input.trim()}>
              Send
            </button>
          </form>
        </section>

        <aside className="side">
          {done ? (
            <div className="card confirm">
              <div className="badge">✓ Callback booked</div>
              <h2>
                {prettyDate(state.date)} · {prettyTime(state.time)}
              </h2>
              <dl>
                {rows.map(([k, v]) => (
                  <div key={k} className="row">
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
              {summary && (
                <div className="summary">
                  <div className="summary-label">Handover note for agent</div>
                  <p>{summary}</p>
                </div>
              )}
              <button className="btn primary full" onClick={() => downloadIcs(state, summary)}>
                Add to calendar (.ics)
              </button>
            </div>
          ) : (
            <div className="card">
              <h3>Captured so far</h3>
              <dl>
                {rows.map(([k, v]) => (
                  <div key={k} className="row">
                    <dt>{k}</dt>
                    <dd className={v ? "" : "pending"}>{v ?? "—"}</dd>
                  </div>
                ))}
              </dl>
              <p className="hint">
                Each value is validated in code before it is saved. Invalid answers are
                re-asked.
              </p>
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
