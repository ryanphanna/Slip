export default function SetupRequired() {
  return <main className="auth-card">
    <p className="eyebrow">Slip</p>
    <h1>One small setup step.</h1>
    <p className="muted">The web app is built, but Firebase configuration has not been provided for this environment. Add the values from <code>web/.env.example</code> as frontend environment variables, then reload.</p>
  </main>;
}
