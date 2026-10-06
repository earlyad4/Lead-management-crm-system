"use client";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="auth-page"><section className="auth-card loading-card"><img src="/brand/crm-logo.svg" alt="Example Company"/><h1>Unable to open this screen</h1><p>Your data was not changed. Retry, or ask the administrator to check the server logs.</p><button className="primary" onClick={reset}>Retry</button></section></main>;
}
