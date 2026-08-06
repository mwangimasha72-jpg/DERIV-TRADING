import { useState, useRef, useCallback, useEffect } from "react";
import { LineChart, Line, ResponsiveContainer, YAxis } from "recharts";

// ---- Synthetic indices offered on the terminal ----
const SYMBOLS = [
  { code: "R_10", name: "Volatility 10 Index", group: "Volatility" },
  { code: "R_25", name: "Volatility 25 Index", group: "Volatility" },
  { code: "R_50", name: "Volatility 50 Index", group: "Volatility" },
  { code: "R_75", name: "Volatility 75 Index", group: "Volatility" },
  { code: "R_100", name: "Volatility 100 Index", group: "Volatility" },
  { code: "1HZ100V", name: "Volatility 100 (1s) Index", group: "Volatility" },
  { code: "BOOM500N", name: "Boom 500 Index", group: "Boom" },
  { code: "BOOM1000N", name: "Boom 1000 Index", group: "Boom" },
  { code: "CRASH500N", name: "Crash 500 Index", group: "Crash" },
  { code: "CRASH1000N", name: "Crash 1000 Index", group: "Crash" },
];

const MAX_MAIN_TICKS = 90;
const MAX_SPARK_TICKS = 24;

const CONTRACT_LABELS = {
  CALL: "Rise",
  PUT: "Fall",
  DIGITEVEN: "Even",
  DIGITODD: "Odd",
  DIGITMATCH: "Matches",
  DIGITDIFF: "Differs",
  DIGITOVER: "Over",
  DIGITUNDER: "Under",
};

function fmt(n, d = 2) {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  return Number(n).toFixed(d);
}

function CandleChart({ data }) {
  if (!data || data.length < 2) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-dim)", fontSize: 12.5 }}>
        Loading candles…
      </div>
    );
  }
  const W = 700;
  const H = 200;
  const pad = 8;
  const highs = data.map((c) => c.high);
  const lows = data.map((c) => c.low);
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  const range = max - min || 1;
  const slot = W / data.length;
  const bw = Math.max(2, slot * 0.55);
  const y = (v) => pad + (1 - (v - min) / range) * (H - pad * 2);
  return (
    <svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {data.map((c, i) => {
        const up = c.close >= c.open;
        const color = up ? "var(--up)" : "var(--down)";
        const cx = i * slot + slot / 2;
        const bodyTop = y(Math.max(c.open, c.close));
        const bodyBottom = y(Math.min(c.open, c.close));
        return (
          <g key={c.epoch || i}>
            <line x1={cx} x2={cx} y1={y(c.high)} y2={y(c.low)} stroke={color} strokeWidth="1" />
            <rect
              x={cx - bw / 2}
              y={bodyTop}
              width={bw}
              height={Math.max(1, bodyBottom - bodyTop)}
              fill={color}
            />
          </g>
        );
      })}
    </svg>
  );
}

function Sparkline({ data, up }) {
  if (!data || data.length < 2) {
    return <svg width="64" height="24" viewBox="0 0 64 24" />;
  }
  const vals = data.map((d) => d.quote);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const pts = vals
    .map((v, i) => {
      const x = (i / (vals.length - 1)) * 64;
      const y = 22 - ((v - min) / range) * 20;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width="64" height="24" viewBox="0 0 64 24">
      <polyline
        points={pts}
        fill="none"
        stroke={up ? "var(--up)" : "var(--down)"}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function DerivTerminal() {
  // connection
  const [token, setToken] = useState("");
  const [appId, setAppId] = useState("1089");
  const [status, setStatus] = useState("disconnected"); // disconnected | connecting | connected
  const [notice, setNotice] = useState(null); // {type, text}
  const wsRef = useRef(null);
  const reqIdRef = useRef(1);
  const pendingRef = useRef({});
  const subsRef = useRef({}); // symbol -> subscription id (ticks)
  const contractSubsRef = useRef({}); // contract_id -> subscription id

  // account
  const [account, setAccount] = useState(null); // {loginid, currency, balance}

  // market data
  const [ticksMap, setTicksMap] = useState({}); // symbol -> [{epoch, quote}]
  const [selectedSymbol, setSelectedSymbol] = useState(SYMBOLS[4].code);
  const [chartMode, setChartMode] = useState("ticks"); // ticks | candles
  const [granularity, setGranularity] = useState(60); // seconds: 60=1m, 300=5m, 900=15m, 3600=1h
  const [candles, setCandles] = useState([]);
  const candleSubRef = useRef(null); // {id, symbol}

  // order ticket
  const [tradeType, setTradeType] = useState("updown"); // updown | evenodd | matchdiff | overunder
  const [contractType, setContractType] = useState("CALL");
  const [barrierDigit, setBarrierDigit] = useState(5);
  const [stake, setStake] = useState("10");
  const [durationTicks, setDurationTicks] = useState(5);
  const [quoting, setQuoting] = useState(false);
  const [quote, setQuote] = useState(null); // proposal object
  const [buying, setBuying] = useState(false);
  const [sellingId, setSellingId] = useState(null);

  // positions / history
  const [positions, setPositions] = useState({}); // contract_id -> contract
  const [history, setHistory] = useState([]);

  const flashNotice = useCallback((type, text, ms = 4000) => {
    setNotice({ type, text });
    if (ms) setTimeout(() => setNotice((n) => (n && n.text === text ? null : n)), ms);
  }, []);

  const send = useCallback((payload, meta) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) return null;
    const req_id = reqIdRef.current++;
    pendingRef.current[req_id] = meta || {};
    ws.send(JSON.stringify({ ...payload, req_id }));
    return req_id;
  }, []);

  const appendTick = useCallback((symbol, epoch, quote) => {
    setTicksMap((prev) => {
      const arr = prev[symbol] ? prev[symbol].slice() : [];
      arr.push({ epoch, quote });
      while (arr.length > MAX_MAIN_TICKS) arr.shift();
      return { ...prev, [symbol]: arr };
    });
  }, []);

  const subscribeContract = useCallback(
    (contract_id) => {
      send(
        { proposal_open_contract: 1, contract_id, subscribe: 1 },
        { type: "poc" }
      );
    },
    [send]
  );

  const handleMessage = useCallback(
    (raw) => {
      const data = JSON.parse(raw);
      const meta = data.req_id ? pendingRef.current[data.req_id] : null;
      if (data.req_id) delete pendingRef.current[data.req_id];

      if (data.error) {
        flashNotice("error", data.error.message || "The request failed.");
        if (data.msg_type === "authorize") {
          setStatus("disconnected");
          wsRef.current && wsRef.current.close();
        }
        if (data.msg_type === "buy") setBuying(false);
        if (data.msg_type === "proposal") setQuoting(false);
        if (data.msg_type === "sell") setSellingId(null);
        return;
      }

      switch (data.msg_type) {
        case "authorize": {
          const a = data.authorize;
          setAccount({ loginid: a.loginid, currency: a.currency, balance: a.balance });
          setStatus("connected");
          flashNotice("success", `Connected to ${a.loginid}.`);
          // live balance
          send({ balance: 1, subscribe: 1 });
          // existing open positions
          send({ portfolio: 1 }, { type: "portfolio" });
          // tick feed for every listed market
          SYMBOLS.forEach((s) => {
            const id = send({ ticks: s.code, subscribe: 1 }, { type: "ticks", symbol: s.code });
            if (id) subsRef.current[s.code] = id;
          });
          break;
        }
        case "balance": {
          setAccount((acc) => (acc ? { ...acc, balance: data.balance.balance } : acc));
          break;
        }
        case "tick": {
          const t = data.tick;
          appendTick(t.symbol, t.epoch, t.quote);
          break;
        }
        case "portfolio": {
          const contracts = data.portfolio.contracts || [];
          contracts.forEach((c) => subscribeContract(c.contract_id));
          break;
        }
        case "proposal": {
          setQuoting(false);
          setQuote(data.proposal);
          break;
        }
        case "buy": {
          setBuying(false);
          setQuote(null);
          flashNotice("success", "Trade opened.");
          subscribeContract(data.buy.contract_id);
          break;
        }
        case "sell": {
          setSellingId(null);
          flashNotice("success", "Position closed.");
          break;
        }
        case "candles": {
          if (meta?.symbol === selectedSymbol) {
            setCandles(data.candles || []);
            if (data.subscription?.id) candleSubRef.current = { id: data.subscription.id, symbol: meta.symbol };
          }
          break;
        }
        case "ohlc": {
          const o = data.ohlc;
          if (!o) break;
          setCandles((prev) => {
            const idx = prev.findIndex((c) => c.epoch === o.open_time);
            const next = { open: +o.open, high: +o.high, low: +o.low, close: +o.close, epoch: o.open_time };
            if (idx >= 0) {
              const copy = prev.slice();
              copy[idx] = next;
              return copy;
            }
            const arr = [...prev, next];
            while (arr.length > 60) arr.shift();
            return arr;
          });
          break;
        }
        case "proposal_open_contract": {
          const c = data.proposal_open_contract;
          if (!c || !c.contract_id) break;
          if (c.is_sold) {
            setPositions((prev) => {
              const next = { ...prev };
              delete next[c.contract_id];
              return next;
            });
            setHistory((prev) => [c, ...prev].slice(0, 20));
          } else {
            setPositions((prev) => ({ ...prev, [c.contract_id]: c }));
          }
          break;
        }
        default:
          break;
      }
    },
    [appendTick, flashNotice, send, subscribeContract, selectedSymbol]
  );

  const connect = useCallback(() => {
    if (!token.trim()) {
      flashNotice("error", "Enter your Deriv API token to connect.");
      return;
    }
    setStatus("connecting");
    const ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${appId || "1089"}`);
    wsRef.current = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ authorize: token.trim() }));
    };
    ws.onmessage = (ev) => handleMessage(ev.data);
    ws.onerror = () => {
      flashNotice("error", "Couldn't reach the Deriv API. Check your connection and try again.");
    };
    ws.onclose = () => {
      setStatus("disconnected");
      setAccount(null);
      setPositions({});
      setQuote(null);
      setCandles([]);
      candleSubRef.current = null;
      subsRef.current = {};
    };
  }, [token, appId, handleMessage, flashNotice]);

  const disconnect = useCallback(() => {
    if (wsRef.current) wsRef.current.close();
  }, []);

  useEffect(() => {
    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  const getQuote = useCallback(() => {
    const amount = parseFloat(stake);
    if (!amount || amount <= 0) {
      flashNotice("error", "Enter a stake greater than 0.");
      return;
    }
    setQuoting(true);
    setQuote(null);
    const needsBarrier = tradeType === "matchdiff" || tradeType === "overunder";
    send(
      {
        proposal: 1,
        amount,
        basis: "stake",
        contract_type: contractType,
        currency: account?.currency || "USD",
        duration: durationTicks,
        duration_unit: "t",
        symbol: selectedSymbol,
        ...(needsBarrier ? { barrier: String(barrierDigit) } : {}),
      },
      { type: "proposal" }
    );
  }, [stake, contractType, account, durationTicks, selectedSymbol, tradeType, barrierDigit, send, flashNotice]);

  const confirmBuy = useCallback(() => {
    if (!quote) return;
    setBuying(true);
    send({ buy: quote.id, price: quote.ask_price }, { type: "buy" });
  }, [quote, send]);

  const sellContract = useCallback(
    (contract_id) => {
      setSellingId(contract_id);
      // price 0 = accept the current market price, i.e. sell now
      send({ sell: contract_id, price: 0 }, { type: "sell" });
    },
    [send]
  );

  const stopCandles = useCallback(() => {
    if (candleSubRef.current?.id) {
      send({ forget: candleSubRef.current.id });
      candleSubRef.current = null;
    }
  }, [send]);

  const requestCandles = useCallback(
    (symbol) => {
      stopCandles();
      setCandles([]);
      send(
        {
          ticks_history: symbol,
          style: "candles",
          granularity,
          count: 60,
          end: "latest",
          subscribe: 1,
        },
        { type: "candles", symbol }
      );
    },
    [send, stopCandles, granularity]
  );

  useEffect(() => {
    if (status !== "connected") return;
    if (chartMode === "candles") {
      requestCandles(selectedSymbol);
    } else {
      stopCandles();
      setCandles([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartMode, selectedSymbol, status, granularity]);

  const switchTradeType = useCallback((type) => {
    setTradeType(type);
    setQuote(null);
    const defaults = { updown: "CALL", evenodd: "DIGITEVEN", matchdiff: "DIGITMATCH", overunder: "DIGITOVER" };
    setContractType(defaults[type]);
  }, []);

  const selectedMeta = SYMBOLS.find((s) => s.code === selectedSymbol);
  const mainTicks = ticksMap[selectedSymbol] || [];
  const lastTick = mainTicks[mainTicks.length - 1];
  const prevTick = mainTicks[mainTicks.length - 2];
  const up = lastTick && prevTick ? lastTick.quote >= prevTick.quote : true;

  const positionList = Object.values(positions).sort((a, b) => b.purchase_time - a.purchase_time);

  return (
    <div
      style={{
        "--bg": "#0A0E13",
        "--surface": "#111820",
        "--surface-2": "#161F29",
        "--border": "#22303C",
        "--text": "#E7EEF4",
        "--text-dim": "#7C8FA0",
        "--up": "#28D9A3",
        "--down": "#FF5C72",
        "--accent": "#5B8CFF",
        "--warn": "#F2B84B",
        fontFamily: "'Inter', sans-serif",
        background: "var(--bg)",
        color: "var(--text)",
        minHeight: "600px",
        borderRadius: "12px",
        overflow: "hidden",
        border: "1px solid var(--border)",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        .dt-mono { font-family: 'IBM Plex Mono', monospace; font-variant-numeric: tabular-nums; }
        .dt-display { font-family: 'Space Grotesk', sans-serif; }
        .dt-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
        .dt-scroll::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
        .dt-btn { cursor: pointer; border: none; transition: filter .15s ease, transform .1s ease; }
        .dt-btn:hover { filter: brightness(1.12); }
        .dt-btn:active { transform: scale(0.98); }
        .dt-btn:focus-visible, .dt-input:focus-visible, .dt-row:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
        .dt-row { cursor: pointer; transition: background .12s ease; }
        .dt-row:hover { background: var(--surface-2); }
        @keyframes dtPulse { 0% { opacity: .9; transform: scaleX(0.2); } 100% { opacity: 0; transform: scaleX(1); } }
        .dt-pulse { animation: dtPulse .55s ease-out; transform-origin: left; }
        @media (prefers-reduced-motion: reduce) { .dt-pulse { animation: none; } }
      `}</style>

      {status !== "connected" ? (
        <div style={{ padding: "48px 32px", maxWidth: 460, margin: "0 auto" }}>
          <div className="dt-display" style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>
            Connect your Deriv account
          </div>
          <div style={{ color: "var(--text-dim)", fontSize: 13.5, lineHeight: 1.5, marginBottom: 24 }}>
            This terminal talks directly to Deriv's own WebSocket API from your browser using your API token.
            Nothing is sent anywhere else, and the token is held only for this session — it's cleared the moment
            you disconnect or reload.
          </div>

          <label style={{ fontSize: 12.5, color: "var(--text-dim)", display: "block", marginBottom: 6 }}>
            API token
          </label>
          <input
            className="dt-input"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste your Deriv API token"
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--text)",
              fontSize: 14,
              marginBottom: 14,
            }}
          />

          <label style={{ fontSize: 12.5, color: "var(--text-dim)", display: "block", marginBottom: 6 }}>
            App ID <span style={{ opacity: 0.7 }}>(optional — defaults to Deriv's shared demo app)</span>
          </label>
          <input
            className="dt-input"
            type="text"
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            placeholder="1089"
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--text)",
              fontSize: 14,
              marginBottom: 20,
            }}
          />

          <button
            className="dt-btn"
            onClick={connect}
            disabled={status === "connecting"}
            style={{
              width: "100%",
              padding: "12px",
              borderRadius: 8,
              background: "var(--accent)",
              color: "#0A0E13",
              fontWeight: 600,
              fontSize: 14.5,
            }}
          >
            {status === "connecting" ? "Connecting…" : "Connect"}
          </button>

          <div
            style={{
              marginTop: 18,
              padding: "10px 12px",
              borderRadius: 8,
              background: "rgba(242,184,75,0.08)",
              border: "1px solid rgba(242,184,75,0.3)",
              color: "var(--warn)",
              fontSize: 12.5,
              lineHeight: 1.5,
            }}
          >
            This connects to your real account. Trades placed here use real funds unless your token belongs to a
            demo/virtual account. Only use a token with the account permissions you're comfortable granting.
          </div>

          {notice && (
            <div
              style={{
                marginTop: 14,
                fontSize: 13,
                color: notice.type === "error" ? "var(--down)" : "var(--up)",
              }}
            >
              {notice.text}
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "220px 1fr 300px", minHeight: 600 }}>
          {/* Sidebar: market list */}
          <div style={{ borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "14px 14px 10px", borderBottom: "1px solid var(--border)" }}>
              <div className="dt-display" style={{ fontWeight: 700, fontSize: 15 }}>
                Synthetics
              </div>
              <div style={{ fontSize: 11.5, color: "var(--text-dim)" }}>{SYMBOLS.length} markets</div>
            </div>
            <div className="dt-scroll" style={{ overflowY: "auto", flex: 1 }}>
              {SYMBOLS.map((s) => {
                const arr = ticksMap[s.code] || [];
                const spark = arr.slice(-MAX_SPARK_TICKS);
                const l = arr[arr.length - 1];
                const p = arr[arr.length - 2];
                const symUp = l && p ? l.quote >= p.quote : true;
                const active = s.code === selectedSymbol;
                return (
                  <div
                    key={s.code}
                    role="button"
                    tabIndex={0}
                    className="dt-row"
                    onClick={() => setSelectedSymbol(s.code)}
                    onKeyDown={(e) => e.key === "Enter" && setSelectedSymbol(s.code)}
                    style={{
                      padding: "9px 14px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      background: active ? "var(--surface-2)" : "transparent",
                      borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 12.5, fontWeight: 500 }}>{s.name}</div>
                      <div className="dt-mono" style={{ fontSize: 12, color: "var(--text-dim)" }}>
                        {l ? fmt(l.quote) : "…"}
                      </div>
                    </div>
                    <Sparkline data={spark} up={symUp} />
                  </div>
                );
              })}
            </div>
            <div style={{ padding: 12, borderTop: "1px solid var(--border)" }}>
              <button
                className="dt-btn"
                onClick={disconnect}
                style={{
                  width: "100%",
                  padding: "8px",
                  borderRadius: 7,
                  background: "var(--surface-2)",
                  color: "var(--text-dim)",
                  fontSize: 12.5,
                }}
              >
                Disconnect
              </button>
            </div>
          </div>

          {/* Center: price + chart + positions */}
          <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid var(--border)" }}>
            <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
                <div>
                  <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{selectedMeta?.group} index</div>
                  <div className="dt-display" style={{ fontSize: 18, fontWeight: 700 }}>
                    {selectedMeta?.name}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div
                    key={lastTick?.epoch}
                    className="dt-mono"
                    style={{ fontSize: 30, fontWeight: 600, color: up ? "var(--up)" : "var(--down)" }}
                  >
                    {lastTick ? fmt(lastTick.quote) : "…"}
                  </div>
                  <div
                    key={"pulse-" + lastTick?.epoch}
                    className="dt-pulse"
                    style={{ height: 2, background: up ? "var(--up)" : "var(--down)", marginTop: 4 }}
                  />
                </div>
              </div>
              {account && (
                <div style={{ marginTop: 10, fontSize: 12, color: "var(--text-dim)" }}>
                  {account.loginid} · balance{" "}
                  <span className="dt-mono" style={{ color: "var(--text)" }}>
                    {fmt(account.balance)} {account.currency}
                  </span>
                </div>
              )}
            </div>

            <div style={{ padding: "10px 20px 0", display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10 }}>
              {chartMode === "candles" && (
                <div style={{ display: "flex", gap: 3 }}>
                  {[
                    [60, "1m"],
                    [300, "5m"],
                    [900, "15m"],
                    [3600, "1h"],
                  ].map(([secs, label]) => (
                    <button
                      key={secs}
                      className="dt-btn dt-mono"
                      onClick={() => setGranularity(secs)}
                      style={{
                        padding: "4px 8px",
                        borderRadius: 6,
                        background: granularity === secs ? "var(--accent)" : "var(--surface)",
                        color: granularity === secs ? "#0A0E13" : "var(--text-dim)",
                        fontSize: 11,
                        border: "1px solid var(--border)",
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              <div style={{ display: "flex", gap: 4 }}>
                <button
                  className="dt-btn"
                  onClick={() => setChartMode("ticks")}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 6,
                    background: chartMode === "ticks" ? "var(--surface-2)" : "transparent",
                    color: chartMode === "ticks" ? "var(--text)" : "var(--text-dim)",
                    fontSize: 11.5,
                  }}
                >
                  Ticks
                </button>
                <button
                  className="dt-btn"
                  onClick={() => setChartMode("candles")}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 6,
                    background: chartMode === "candles" ? "var(--surface-2)" : "transparent",
                    color: chartMode === "candles" ? "var(--text)" : "var(--text-dim)",
                    fontSize: 11.5,
                  }}
                >
                  Candles
                </button>
              </div>
            </div>

            <div style={{ height: 220, padding: "10px 8px 0" }}>
              {chartMode === "ticks" ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={mainTicks}>
                    <YAxis domain={["dataMin", "dataMax"]} hide />
                    <Line
                      type="monotone"
                      dataKey="quote"
                      stroke={up ? "var(--up)" : "var(--down)"}
                      strokeWidth={1.75}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <CandleChart data={candles} />
              )}
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: "10px 20px 20px" }} className="dt-scroll">
              <div style={{ fontSize: 12.5, color: "var(--text-dim)", marginBottom: 8, marginTop: 8 }}>
                Open positions {positionList.length ? `(${positionList.length})` : ""}
              </div>
              {positionList.length === 0 ? (
                <div style={{ fontSize: 12.5, color: "var(--text-dim)", opacity: 0.7 }}>
                  Nothing open yet. Place a trade from the ticket on the right.
                </div>
              ) : (
                positionList.map((c) => {
                  const profit = c.profit ?? 0;
                  const isSelling = sellingId === c.contract_id;
                  return (
                    <div
                      key={c.contract_id}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "8px 10px",
                        marginBottom: 6,
                        borderRadius: 7,
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 12.5, fontWeight: 500 }}>
                          {c.display_name || c.underlying} · {CONTRACT_LABELS[c.contract_type] || c.contract_type}
                        </div>
                        <div style={{ fontSize: 11.5, color: "var(--text-dim)" }}>Stake {fmt(c.buy_price)}</div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div
                          className="dt-mono"
                          style={{ fontSize: 13, color: profit >= 0 ? "var(--up)" : "var(--down)" }}
                        >
                          {profit >= 0 ? "+" : ""}
                          {fmt(profit)}
                        </div>
                        {c.is_sellable !== 0 && (
                          <button
                            className="dt-btn"
                            onClick={() => sellContract(c.contract_id)}
                            disabled={isSelling}
                            style={{
                              padding: "5px 9px",
                              borderRadius: 6,
                              background: "var(--surface-2)",
                              color: "var(--text-dim)",
                              fontSize: 11,
                            }}
                          >
                            {isSelling ? "Selling…" : "Sell"}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}

              {history.length > 0 && (
                <>
                  <div style={{ fontSize: 12.5, color: "var(--text-dim)", margin: "16px 0 8px" }}>Recent history</div>
                  {history.map((c) => {
                    const profit = c.profit ?? 0;
                    return (
                      <div
                        key={c.contract_id}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          padding: "6px 10px",
                          fontSize: 12,
                          color: "var(--text-dim)",
                        }}
                      >
                        <span>
                          {c.display_name || c.underlying} · {CONTRACT_LABELS[c.contract_type] || c.contract_type}
                        </span>
                        <span className="dt-mono" style={{ color: profit >= 0 ? "var(--up)" : "var(--down)" }}>
                          {profit >= 0 ? "+" : ""}
                          {fmt(profit)}
                        </span>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </div>

          {/* Right: order ticket */}
          <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="dt-display" style={{ fontWeight: 700, fontSize: 15 }}>
              New trade
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 4,
                background: "var(--surface)",
                borderRadius: 8,
                padding: 3,
              }}
            >
              {[
                ["updown", "Rise / Fall"],
                ["evenodd", "Even / Odd"],
                ["matchdiff", "Matches / Differs"],
                ["overunder", "Over / Under"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  className="dt-btn"
                  onClick={() => switchTradeType(key)}
                  style={{
                    padding: "7px 4px",
                    borderRadius: 6,
                    background: tradeType === key ? "var(--surface-2)" : "transparent",
                    color: tradeType === key ? "var(--text)" : "var(--text-dim)",
                    fontSize: 11.5,
                    fontWeight: 500,
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="dt-btn"
                onClick={() =>
                  setContractType(
                    { updown: "CALL", evenodd: "DIGITEVEN", matchdiff: "DIGITMATCH", overunder: "DIGITOVER" }[
                      tradeType
                    ]
                  )
                }
                style={{
                  flex: 1,
                  padding: "10px",
                  borderRadius: 8,
                  background: ["CALL", "DIGITEVEN", "DIGITMATCH", "DIGITOVER"].includes(contractType)
                    ? "var(--up)"
                    : "var(--surface-2)",
                  color: ["CALL", "DIGITEVEN", "DIGITMATCH", "DIGITOVER"].includes(contractType)
                    ? "#06231A"
                    : "var(--text)",
                  fontWeight: 600,
                  fontSize: 13,
                }}
              >
                {{ updown: "Rise", evenodd: "Even", matchdiff: "Matches", overunder: "Over" }[tradeType]}
              </button>
              <button
                className="dt-btn"
                onClick={() =>
                  setContractType(
                    { updown: "PUT", evenodd: "DIGITODD", matchdiff: "DIGITDIFF", overunder: "DIGITUNDER" }[
                      tradeType
                    ]
                  )
                }
                style={{
                  flex: 1,
                  padding: "10px",
                  borderRadius: 8,
                  background: ["PUT", "DIGITODD", "DIGITDIFF", "DIGITUNDER"].includes(contractType)
                    ? "var(--down)"
                    : "var(--surface-2)",
                  color: ["PUT", "DIGITODD", "DIGITDIFF", "DIGITUNDER"].includes(contractType)
                    ? "#2A0810"
                    : "var(--text)",
                  fontWeight: 600,
                  fontSize: 13,
                }}
              >
                {{ updown: "Fall", evenodd: "Odd", matchdiff: "Differs", overunder: "Under" }[tradeType]}
              </button>
            </div>

            {(tradeType === "matchdiff" || tradeType === "overunder") && (
              <div>
                <label style={{ fontSize: 12, color: "var(--text-dim)", display: "block", marginBottom: 5 }}>
                  {tradeType === "matchdiff" ? "Digit to match" : "Barrier digit"}
                </label>
                <div style={{ display: "flex", gap: 4 }}>
                  {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
                    <button
                      key={d}
                      className="dt-btn dt-mono"
                      onClick={() => setBarrierDigit(d)}
                      style={{
                        flex: 1,
                        padding: "7px 0",
                        borderRadius: 6,
                        background: barrierDigit === d ? "var(--accent)" : "var(--surface)",
                        color: barrierDigit === d ? "#0A0E13" : "var(--text-dim)",
                        fontSize: 12,
                        border: "1px solid var(--border)",
                      }}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <label style={{ fontSize: 12, color: "var(--text-dim)", display: "block", marginBottom: 5 }}>
                Stake ({account?.currency || "USD"})
              </label>
              <input
                className="dt-input dt-mono"
                type="number"
                min="0"
                value={stake}
                onChange={(e) => setStake(e.target.value)}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "9px 11px",
                  borderRadius: 7,
                  border: "1px solid var(--border)",
                  background: "var(--surface)",
                  color: "var(--text)",
                  fontSize: 14,
                }}
              />
            </div>

            <div>
              <label style={{ fontSize: 12, color: "var(--text-dim)", display: "block", marginBottom: 5 }}>
                Duration (ticks)
              </label>
              <input
                className="dt-input dt-mono"
                type="number"
                min="1"
                max="10"
                value={durationTicks}
                onChange={(e) => setDurationTicks(parseInt(e.target.value || "1", 10))}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "9px 11px",
                  borderRadius: 7,
                  border: "1px solid var(--border)",
                  background: "var(--surface)",
                  color: "var(--text)",
                  fontSize: 14,
                }}
              />
            </div>

            {!quote ? (
              <button
                className="dt-btn"
                onClick={getQuote}
                disabled={quoting}
                style={{
                  padding: "12px",
                  borderRadius: 8,
                  background: "var(--accent)",
                  color: "#0A0E13",
                  fontWeight: 600,
                  fontSize: 14,
                }}
              >
                {quoting ? "Getting price…" : "Get price"}
              </button>
            ) : (
              <div
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: 12,
                  background: "var(--surface)",
                }}
              >
                <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 6 }}>
                  {quote.longcode}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                  <span style={{ color: "var(--text-dim)" }}>Cost</span>
                  <span className="dt-mono">{fmt(quote.ask_price)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 10 }}>
                  <span style={{ color: "var(--text-dim)" }}>Payout if correct</span>
                  <span className="dt-mono" style={{ color: "var(--up)" }}>
                    {fmt(quote.payout)}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="dt-btn"
                    onClick={confirmBuy}
                    disabled={buying}
                    style={{
                      flex: 1,
                      padding: "10px",
                      borderRadius: 7,
                      background: "var(--accent)",
                      color: "#0A0E13",
                      fontWeight: 600,
                      fontSize: 13,
                    }}
                  >
                    {buying ? "Placing…" : "Confirm trade"}
                  </button>
                  <button
                    className="dt-btn"
                    onClick={() => setQuote(null)}
                    style={{
                      padding: "10px 14px",
                      borderRadius: 7,
                      background: "var(--surface-2)",
                      color: "var(--text-dim)",
                      fontSize: 13,
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {notice && (
              <div
                style={{
                  fontSize: 12.5,
                  color: notice.type === "error" ? "var(--down)" : "var(--up)",
                }}
              >
                {notice.text}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
