import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

type View = "trigger" | "jobs" | "dead_letters";
type JobStatus = "pending" | "processing" | "succeeded" | "failed" | "dead";
type IconName = "clock" | "loader" | "check" | "rotate" | "octagon" | "copy" | "close" | "trigger" | "queue" | "inbox" | "search" | "offline" | "arrow";
type NoticeKind = "success" | "error" | "info" | "offline";

interface JobRecord {
  id: string;
  type: string;
  payload: unknown;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  run_at: string;
  started_at: string | null;
  finished_at: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

interface JobStats {
  pending: number;
  processing: number;
  succeeded: number;
  failed: number;
  dead: number;
  total: number;
  workerConcurrency: number;
}

interface Envelope<T> {
  data: T;
  meta?: {
    duplicate?: boolean;
    total?: number;
    hasMore?: boolean;
  };
}

interface Notice {
  kind: NoticeKind;
  text: string;
  jobId?: string;
}

const POLL_INTERVAL_MS = 2000;
const DEFAULT_RETRY_AFTER_SECONDS = 5;
const BULK_JOB_COUNT = 50;
const STATUSES: JobStatus[] = ["pending", "processing", "succeeded", "failed", "dead"];

const ICON_PATHS: Record<IconName, React.ReactNode> = {
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  loader: <path d="M12 3a9 9 0 1 0 9 9" />,
  check: <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>,
  rotate: <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></>,
  octagon: <><path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z" /><path d="m9 9 6 6m0-6-6 6" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  trigger: <><circle cx="12" cy="12" r="9" /><path d="M12 8v8m-4-4h8" /></>,
  queue: <><rect x="3" y="4" width="18" height="6" rx="2" /><rect x="3" y="14" width="18" height="6" rx="2" /></>,
  inbox: <><path d="M4 13h4l2 3h4l2-3h4" /><path d="M5 5h14l2 8v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
  offline: <><path d="m3 3 18 18" /><path d="M8.5 16.5a5 5 0 0 1 7 0M5 12a10 10 0 0 1 3-2M19 12a10 10 0 0 0-6-2.8" /></>,
  arrow: <path d="m9 6 6 6-6 6" />,
};

const STATUS_META: Record<JobStatus, { label: string; icon: IconName }> = {
  pending: { label: "Pending", icon: "clock" },
  processing: { label: "Processing", icon: "loader" },
  succeeded: { label: "Succeeded", icon: "check" },
  failed: { label: "Failed, retrying", icon: "rotate" },
  dead: { label: "Dead", icon: "octagon" },
};

const VIEW_META: Record<View, { title: string; subtitle: string; icon: IconName }> = {
  trigger: { title: "Trigger a job", subtitle: "Queue work without blocking the request.", icon: "trigger" },
  jobs: { title: "Jobs", subtitle: "Every job, its state, and its next run.", icon: "queue" },
  dead_letters: { title: "Dead letters", subtitle: "Retries are exhausted. These need a human.", icon: "inbox" },
};

function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {ICON_PATHS[name]}
    </svg>
  );
}

function StatusBadge({ status }: { status: JobStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.pending;
  return (
    <span className={`badge badge--${status}`}>
      <span className="badge-icon"><Icon name={meta.icon} /></span>
      {meta.label}
    </span>
  );
}

function formatClock(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function relativeTime(value: string): string {
  const delta = new Date(value).getTime() - Date.now();
  const seconds = Math.round(Math.abs(delta) / 1000);
  const amount = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds / 3600)}h`;
  return delta >= 0 ? `in ${amount}` : `${amount} ago`;
}

function shortId(id: string): string {
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

export default function App() {
  const [activeView, setActiveView] = useState<View>(() => {
    const requested = new URLSearchParams(window.location.search).get("view");
    return requested === "trigger" || requested === "dead_letters" || requested === "jobs" ? requested : "jobs";
  });
  const [apiUrl, setApiUrl] = useState(() =>
    new URLSearchParams(window.location.search).get("api") ||
    (import.meta as any).env?.VITE_API_URL ||
    "http://localhost:3001"
  );
  const [stats, setStats] = useState<JobStats | null>(null);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [deadLetters, setDeadLetters] = useState<JobRecord[]>([]);
  const [selectedJob, setSelectedJob] = useState<JobRecord | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>(() => {
    const requested = new URLSearchParams(window.location.search).get("status");
    return requested && ["all", "pending", "processing", "succeeded", "failed", "dead"].includes(requested)
      ? requested
      : "all";
  });
  const [searchTerm, setSearchTerm] = useState("");
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [visible, setVisible] = useState(!document.hidden);
  const [rateLimitedUntil, setRateLimitedUntil] = useState<number | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [jobType, setJobType] = useState("send_welcome_email");
  const [recipient, setRecipient] = useState("alex@example.com");
  const [forceFail, setForceFail] = useState(false);
  const [customKey, setCustomKey] = useState("");

  const hasLoadedRef = useRef(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);

  const requestJson = useCallback(async <T,>(path: string, init?: RequestInit): Promise<Envelope<T>> => {
    const res = await fetch(`${apiUrl.replace(/\/+$/, "")}${path}`, init);
    if (res.status === 429) {
      const header = Number(res.headers.get("Retry-After"));
      const seconds = Number.isFinite(header) && header > 0 ? header : DEFAULT_RETRY_AFTER_SECONDS;
      setRateLimitedUntil(Date.now() + seconds * 1000);
      throw new Error(`Too many requests. Try again in ${seconds} seconds.`);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new Error(body?.error?.message || `Request failed with status ${res.status}`);
    }
    return await res.json() as Envelope<T>;
  }, [apiUrl]);

  const refreshData = useCallback(async () => {
    if (rateLimitedUntil || offline) return;
    if (!hasLoadedRef.current) setLoading(true);
    try {
      const statsResult = await requestJson<JobStats>("/api/stats");
      setStats(statsResult.data);
      if (activeView === "jobs") {
        const query = filterStatus === "all" ? "" : `?status=${filterStatus}`;
        const jobsResult = await requestJson<JobRecord[]>(`/api/jobs${query}`);
        setJobs(jobsResult.data ?? []);
      } else if (activeView === "dead_letters") {
        const deadResult = await requestJson<JobRecord[]>("/api/dead-letters");
        setDeadLetters(deadResult.data ?? []);
      }
      setApiError(null);
      hasLoadedRef.current = true;
    } catch (err) {
      setApiError(err instanceof Error ? err.message : "The API could not be reached");
    } finally {
      setLoading(false);
    }
  }, [requestJson, activeView, filterStatus, rateLimitedUntil, offline]);

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    const onVisibility = () => setVisible(!document.hidden);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    if (rateLimitedUntil || offline || !visible) return;
    void refreshData();
    const id = window.setInterval(() => { void refreshData(); }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refreshData, rateLimitedUntil, offline, visible]);

  useEffect(() => {
    if (!rateLimitedUntil) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((rateLimitedUntil - Date.now()) / 1000));
      setCountdown(remaining);
      if (remaining === 0) {
        setRateLimitedUntil(null);
        setNotice(null);
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [rateLimitedUntil]);

  useEffect(() => {
    if (!selectedJob) return;
    lastFocusRef.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedJob(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      lastFocusRef.current?.focus();
    };
  }, [selectedJob?.id]);

  const handleEnqueue = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setNotice(null);
    const key = customKey.trim() || `idem_${crypto.randomUUID()}`;
    try {
      const result = await requestJson<JobRecord>("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: jobType,
          payload: { to: recipient, force_fail: forceFail, subject: "Welcome to our product!" },
          idempotency_key: key,
        }),
      });
      setNotice({
        kind: "success",
        text: result.meta?.duplicate ? `This job already exists: ${key}.` : `Accepted job ${shortId(result.data.id)} with 202.`,
        jobId: result.data.id,
      });
      setCustomKey("");
      void refreshData();
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : "Could not enqueue the job" });
    } finally {
      setSubmitting(false);
    }
  };

  const handleBulk = async () => {
    setBulkSubmitting(true);
    setNotice(null);
    const stamp = Date.now();
    try {
      const results = await Promise.all(Array.from({ length: BULK_JOB_COUNT }, (_, index) =>
        requestJson<JobRecord>("/api/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "send_welcome_email",
            payload: { to: recipient, force_fail: false, subject: "Concurrency check" },
            idempotency_key: `test_bulk_${stamp}_${index}`,
          }),
        })
      ));
      setNotice({ kind: "success", text: `Queued ${results.length} test jobs. Watch the concurrency count.` });
      void refreshData();
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : "The test enqueue stopped" });
    } finally {
      setBulkSubmitting(false);
    }
  };

  const handleRetry = async (id: string) => {
    setRetryingId(id);
    setNotice(null);
    try {
      const result = await requestJson<JobRecord>(`/api/dead-letters/${id}/retry`, { method: "POST" });
      setNotice({ kind: "success", text: `Job ${shortId(id)} is pending again.`, jobId: result.data.id });
      if (selectedJob?.id === id) setSelectedJob(result.data);
      void refreshData();
    } catch (err) {
      setNotice({ kind: "error", text: `Retry failed: ${err instanceof Error ? err.message : "unknown error"}` });
    } finally {
      setRetryingId(null);
    }
  };

  const viewJob = async (id: string) => {
    try {
      const result = await requestJson<JobRecord>(`/api/jobs/${id}`);
      setSelectedJob(result.data);
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : "Could not load the job" });
    }
  };

  const handleCopy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice({ kind: "info", text: "Copied the full id to the clipboard." });
    } catch {
      setNotice({ kind: "error", text: "Clipboard access was blocked. Select the id to copy it." });
    }
  };

  const search = searchTerm.trim().toLowerCase();
  const visibleJobs = useMemo(() => {
    if (!search) return jobs;
    return jobs.filter((job) =>
      job.id.toLowerCase().includes(search) ||
      job.idempotency_key.toLowerCase().includes(search) ||
      job.type.toLowerCase().includes(search)
    );
  }, [jobs, search]);

  const paused = offline || rateLimitedUntil !== null || !visible;
  const view = VIEW_META[activeView];

  const navItems: { view: View; count?: number }[] = [
    { view: "trigger" },
    { view: "jobs" },
    { view: "dead_letters", count: stats?.dead },
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Console navigation">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">JQ</span>
          <span>
            <span className="brand-name">Job Queue</span>
            <span className="brand-sub">Console</span>
          </span>
        </div>
        <nav className="sidebar-nav" aria-label="Views">
          {navItems.map((item) => (
            <button
              key={item.view}
              type="button"
              className="nav-link"
              aria-current={activeView === item.view ? "page" : undefined}
              onClick={() => { setActiveView(item.view); setNotice(null); }}
            >
              <Icon name={VIEW_META[item.view].icon} />
              {VIEW_META[item.view].title}
              {item.view === "dead_letters" && item.count ? <span className="nav-count">{item.count}</span> : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <label className="endpoint-label" htmlFor="sidebar-api">API endpoint</label>
          <input
            id="sidebar-api"
            className="endpoint-input"
            value={apiUrl}
            onChange={(event) => setApiUrl(event.target.value)}
            spellCheck={false}
          />
          <span className={`connection${offline ? " connection--offline" : ""}`}>
            <span className="live-dot" aria-hidden="true" />
            {offline ? "Offline" : stats ? "Connected" : "Connecting"}
          </span>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <h1 className="page-title">{view.title}</h1>
            <p className="page-subtitle">{view.subtitle}</p>
          </div>
          <div className="topbar-right">
            {stats && (
              <span className="processing-pill">
                <Icon name="loader" className={stats.processing > 0 ? "spinner" : undefined} />
                Processing <strong>{stats.processing}/{stats.workerConcurrency}</strong>
              </span>
            )}
            <span className={`live-pill${paused ? " live-pill--paused" : ""}`} aria-live="polite">
              <span className="live-dot" aria-hidden="true" />
              {offline ? "Offline" : rateLimitedUntil ? "Rate limited" : !visible ? "Paused" : `Live · ${POLL_INTERVAL_MS / 1000}s`}
            </span>
          </div>
        </header>

        <nav className="mobile-nav" aria-label="Views">
          {navItems.map((item) => (
            <button
              key={item.view}
              type="button"
              aria-current={activeView === item.view ? "page" : undefined}
              onClick={() => { setActiveView(item.view); setNotice(null); }}
            >
              {VIEW_META[item.view].title}
              {item.view === "dead_letters" && item.count ? ` (${item.count})` : ""}
            </button>
          ))}
          <label className="sr-only" htmlFor="mobile-api">API endpoint</label>
          <input
            id="mobile-api"
            className="endpoint-input mobile-api"
            value={apiUrl}
            onChange={(event) => setApiUrl(event.target.value)}
            spellCheck={false}
          />
        </nav>

        <main className="content">
          {offline && (
            <div className="banner banner--offline" role="status">
              <Icon name="offline" />
              <span>You are offline. Showing the last loaded data.</span>
            </div>
          )}

          {rateLimitedUntil !== null && (
            <div className="banner banner--offline" role="status" aria-live="polite">
              <span>Too many requests. Resuming in {countdown}s.</span>
            </div>
          )}

          {apiError && (
            <div className="banner banner--error" role="alert">
              <span>API unreachable: {apiError}</span>
              <button type="button" className="banner-link" onClick={() => { void refreshData(); }}>
                Try again
              </button>
            </div>
          )}

          {notice && (
            <div className={`banner banner--${notice.kind}`} role="status" aria-live="polite">
              <span>{notice.text}</span>
              <span className="banner-actions">
                {notice.jobId && (
                  <button type="button" className="banner-link" onClick={() => { void viewJob(notice.jobId!); }}>
                    View job <Icon name="arrow" />
                  </button>
                )}
                <button type="button" className="banner-close" aria-label="Dismiss message" onClick={() => setNotice(null)}>
                  <Icon name="close" />
                </button>
              </span>
            </div>
          )}

          {activeView === "jobs" && (
            <>
              <section className="counts" aria-label="Job counts">
                {STATUSES.map((status) => (
                  <div key={status} className={`count-tile count-tile--${status}`}>
                    <span className="count-label"><Icon name={STATUS_META[status].icon} />{STATUS_META[status].label}</span>
                    <span className="count-value tabular">{stats ? stats[status] : "—"}</span>
                  </div>
                ))}
              </section>

              <div className="toolbar">
                <div className="segmented" role="group" aria-label="Filter jobs by status">
                  {["all", ...STATUSES].map((status) => (
                    <button
                      key={status}
                      type="button"
                      className="segment"
                      aria-pressed={filterStatus === status}
                      onClick={() => setFilterStatus(status)}
                    >
                      {status === "all" ? "All" : STATUS_META[status as JobStatus].label}
                    </button>
                  ))}
                </div>
                <div className="find-field">
                  <Icon name="search" />
                  <input
                    className="find-input"
                    value={searchTerm}
                    onChange={(event) => setSearchTerm(event.target.value)}
                    placeholder="Find in loaded jobs"
                    aria-label="Find in loaded jobs by id, key or type"
                  />
                </div>
              </div>

              <section className="panel" aria-label="Jobs">
                <div className="panel-head">
                  <h2 className="panel-title">{stats ? `${stats.total} jobs in the queue` : "Loading jobs"}</h2>
                  <p className="panel-desc">Select a row to inspect its state, payload and lifecycle timestamps.</p>
                </div>
                {loading && jobs.length === 0 ? (
                  <div aria-label="Loading jobs">
                    {[0, 1, 2, 3].map((row) => (
                      <div className="skeleton-row" key={row}>
                        <span className="sk sk--small" /><span className="sk sk--mid" /><span className="sk sk--wide" />
                      </div>
                    ))}
                  </div>
                ) : visibleJobs.length === 0 ? (
                  <div className="empty">
                    <Icon name="queue" size={20} />
                    <span className="empty-title">{jobs.length === 0 ? "No jobs yet" : "No jobs match this filter"}</span>
                    <p className="empty-text">
                      {jobs.length === 0
                        ? "Enqueue one from the Trigger view to see it move through the queue."
                        : "Clear the status filter or search term to see the loaded jobs again."}
                    </p>
                    {jobs.length === 0 ? (
                      <button type="button" className="button button--secondary button--small" onClick={() => setActiveView("trigger")}>
                        Go to Trigger
                      </button>
                    ) : (
                      <button type="button" className="button button--secondary button--small" onClick={() => { setFilterStatus("all"); setSearchTerm(""); }}>
                        Clear filters
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th scope="col">Status</th>
                          <th scope="col">Job</th>
                          <th scope="col">Type</th>
                          <th scope="col">Attempts</th>
                          <th scope="col">Next run</th>
                          <th scope="col">Created</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleJobs.map((job) => (
                          <tr key={job.id}>
                            <td data-label="Status"><StatusBadge status={job.status} /></td>
                            <td data-label="Job">
                              <span className="job-cell">
                                <button type="button" className="row-button" onClick={() => setSelectedJob(job)} aria-label={`Open details for job ${job.id}`}>
                                  <span title={job.id}>{shortId(job.id)}</span>
                                </button>
                                <button type="button" className="copy-button" aria-label={`Copy id for job ${job.id}`} onClick={() => { void handleCopy(job.id); }}>
                                  <Icon name="copy" />
                                </button>
                              </span>
                            </td>
                            <td data-label="Type" className="mono muted">{job.type}</td>
                            <td data-label="Attempts">
                              <span className="attempt-cell tabular">
                                <span>{job.attempts}/{job.max_attempts}</span>
                                <span className="attempt-track" aria-hidden="true">
                                  <span className="attempt-fill" style={{ width: `${Math.min(100, (job.attempts / job.max_attempts) * 100)}%` }} />
                                </span>
                              </span>
                            </td>
                            <td data-label="Next run" className="tabular nowrap" title={job.run_at}>
                              {job.status === "failed" || job.status === "pending" ? relativeTime(job.run_at) : "—"}
                            </td>
                            <td data-label="Created" className="tabular nowrap muted" title={job.created_at}>{formatClock(job.created_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}

          {activeView === "trigger" && (
            <section className="panel">
              <div className="panel-head">
                <h2 className="panel-title">Enqueue background task</h2>
                <p className="panel-desc">The request returns 202 immediately. A separate worker does the work.</p>
              </div>
              <form className="form-grid" onSubmit={handleEnqueue}>
                <div className="field">
                  <label className="field-label" htmlFor="job-type">Job type</label>
                  <select id="job-type" className="select" value={jobType} onChange={(event) => setJobType(event.target.value)}>
                    <option value="send_welcome_email">send_welcome_email</option>
                    <option value="send_receipt_email">send_receipt_email</option>
                    <option value="export_order_csv">export_order_csv</option>
                  </select>
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="recipient">Recipient email</label>
                  <input id="recipient" className="input" type="email" value={recipient} onChange={(event) => setRecipient(event.target.value)} required />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="idem-key">Idempotency key</label>
                  <input
                    id="idem-key"
                    className="input input--mono"
                    value={customKey}
                    onChange={(event) => setCustomKey(event.target.value)}
                    placeholder="Generated automatically when left blank"
                  />
                  <p className="field-hint">Reuse a key to prove the duplicate returns the existing job.</p>
                </div>
                <div className="checkbox-row">
                  <input id="force-fail" type="checkbox" checked={forceFail} onChange={(event) => setForceFail(event.target.checked)} />
                  <label htmlFor="force-fail">Simulate downstream failure to trace retries and backoff</label>
                </div>
                <div className="form-actions">
                  <button type="submit" className="button button--primary" disabled={submitting}>
                    {submitting ? <><Icon name="loader" className="spinner" /> Enqueueing</> : "Enqueue job"}
                  </button>
                  <button type="button" className="button button--secondary" onClick={() => { void handleBulk(); }} disabled={bulkSubmitting}>
                    {bulkSubmitting ? <><Icon name="loader" className="spinner" /> Queuing</> : "Test: enqueue 50"}
                  </button>
                </div>
              </form>
            </section>
          )}

          {activeView === "dead_letters" && (
            <section className="panel">
              <div className="panel-head">
                <h2 className="panel-title">Dead letter queue</h2>
                <p className="panel-desc">Jobs here exhausted their attempts. Workers will not claim them again.</p>
              </div>
              {loading && deadLetters.length === 0 ? (
                <div aria-label="Loading dead letters">
                  {[0, 1, 2].map((row) => (
                    <div className="skeleton-row" key={row}>
                      <span className="sk sk--small" /><span className="sk sk--wide" /><span className="sk sk--mid" />
                    </div>
                  ))}
                </div>
              ) : deadLetters.length === 0 ? (
                <div className="empty">
                  <Icon name="check" size={20} />
                  <span className="empty-title">Nothing needs attention</span>
                  <p className="empty-text">No dead jobs. Failed jobs with retries left stay in the Jobs view.</p>
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th scope="col">Job</th>
                        <th scope="col">Payload</th>
                        <th scope="col">Last error</th>
                        <th scope="col">Attempts</th>
                        <th scope="col">First seen</th>
                        <th scope="col">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {deadLetters.map((job) => (
                        <tr key={job.id}>
                          <td data-label="Job" className="mono" title={job.id}>{shortId(job.id)}</td>
                          <td data-label="Payload" className="mono muted">{JSON.stringify(job.payload)}</td>
                          <td data-label="Last error" className="error-text">{job.last_error ?? "Unknown error"}</td>
                          <td data-label="Attempts" className="tabular">{job.attempts}/{job.max_attempts}</td>
                          <td data-label="First seen" className="tabular muted" title={job.created_at}>{formatClock(job.created_at)}</td>
                          <td data-label="Action">
                            <button type="button" className="button button--primary button--small" disabled={retryingId === job.id} onClick={() => { void handleRetry(job.id); }}>
                              {retryingId === job.id ? <><Icon name="loader" className="spinner" /> Retrying</> : "Retry job"}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </main>
      </div>

      {selectedJob && (
        <>
          <div className="drawer-backdrop" onClick={() => setSelectedJob(null)} aria-hidden="true" />
          <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
            <div className="drawer-head">
              <h2 className="drawer-title" id="drawer-title">Job details</h2>
              <button ref={closeRef} type="button" className="drawer-close" aria-label="Close job details" onClick={() => setSelectedJob(null)}>
                <Icon name="close" />
              </button>
            </div>
            <div className="drawer-body">
              <StatusBadge status={selectedJob.status} />
              <div className="detail-row">
                <span className="detail-label">Job id</span>
                <span className="detail-value mono">{selectedJob.id}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Idempotency key</span>
                <span className="detail-value mono">{selectedJob.idempotency_key}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Type</span>
                <span className="detail-value mono">{selectedJob.type}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Attempts</span>
                <span className="detail-value tabular">Attempt {selectedJob.attempts} of {selectedJob.max_attempts}</span>
              </div>
              {selectedJob.last_error && (
                <div className="detail-row">
                  <span className="detail-label error-text">Last error</span>
                  <pre className="code-block error-text">{selectedJob.last_error}</pre>
                </div>
              )}
              <div className="detail-row">
                <span className="detail-label">Lifecycle</span>
                <ol className="timeline">
                  <li className="timeline-item">
                    <span className="timeline-dot" aria-hidden="true" />
                    <span className="timeline-body">
                      <span className="timeline-label">Created</span>
                      <span className="timeline-time">{formatClock(selectedJob.created_at)}</span>
                    </span>
                  </li>
                  <li className="timeline-item">
                    <span className="timeline-dot" aria-hidden="true" />
                    <span className="timeline-body">
                      <span className="timeline-label">Started</span>
                      <span className="timeline-time">{formatClock(selectedJob.started_at)}</span>
                    </span>
                  </li>
                  <li className="timeline-item">
                    <span className="timeline-dot" aria-hidden="true" />
                    <span className="timeline-body">
                      <span className="timeline-label">{selectedJob.status === "failed" ? "Next retry" : "Scheduled run"}</span>
                      <span className="timeline-time">{formatClock(selectedJob.run_at)} · {relativeTime(selectedJob.run_at)}</span>
                    </span>
                  </li>
                  <li className="timeline-item">
                    <span className="timeline-dot" aria-hidden="true" />
                    <span className="timeline-body">
                      <span className="timeline-label">Finished</span>
                      <span className="timeline-time">{formatClock(selectedJob.finished_at)}</span>
                    </span>
                  </li>
                </ol>
                <p className="timeline-note">Per-attempt history is not stored. These are the persisted timestamps for the current attempt.</p>
              </div>
              <details className="details-block">
                <summary className="details-summary">Payload</summary>
                <pre className="code-block">{JSON.stringify(selectedJob.payload, null, 2)}</pre>
              </details>
              {selectedJob.status === "dead" && (
                <div className="drawer-actions">
                  <button type="button" className="button button--primary" disabled={retryingId === selectedJob.id} onClick={() => { void handleRetry(selectedJob.id); }}>
                    {retryingId === selectedJob.id ? <><Icon name="loader" className="spinner" /> Retrying</> : "Retry job"}
                  </button>
                </div>
              )}
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
