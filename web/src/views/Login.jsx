import { useEffect, useRef, useState } from 'react';
import { RecaptchaVerifier, signInWithPhoneNumber } from 'firebase/auth';
import { auth } from '../firebase.js';
import { normalizePhone } from '../format.js';

export default function Login() {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [confirmation, setConfirmation] = useState(null);
  const [message, setMessage] = useState('');
  const recaptcha = useRef(null);

  function createRecaptcha() {
    if (!recaptcha.current) recaptcha.current = new RecaptchaVerifier(auth, 'recaptcha', { size: 'invisible' });
    return recaptcha.current;
  }

  useEffect(() => {
    createRecaptcha();
    return () => {
      recaptcha.current?.clear();
      recaptcha.current = null;
    };
  }, []);

  async function sendCode(event) {
    event.preventDefault();
    const normalizedPhone = normalizePhone(phone);
    if (!/^\+\d{8,15}$/.test(normalizedPhone)) {
      setMessage('Enter a valid phone number, such as (416) 555-1234.');
      return;
    }
    setMessage('Sending code…');
    try {
      const verifier = createRecaptcha();
      const result = await signInWithPhoneNumber(auth, normalizedPhone, verifier);
      verifier.clear();
      recaptcha.current = null;
      setConfirmation(result);
      setMessage('Enter the six-digit code we texted you.');
    } catch (error) {
      recaptcha.current?.clear();
      recaptcha.current = null;
      setMessage(error.message || 'Could not send a code.');
    }
  }

  async function verifyCode(event) {
    event.preventDefault();
    setMessage('Verifying…');
    try {
      await confirmation.confirm(code);
    } catch (error) {
      setMessage(error.message || 'That code did not work.');
    }
  }

  return <main className="auth-card">
    <p className="eyebrow">Slip</p>
    <h1>Your receipts, without the shoebox.</h1>
    <p className="muted">Sign in with the phone number you use to text receipts to Slip.</p>
    {!confirmation ? <form onSubmit={sendCode}>
      <label>Phone number<input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 416 555 1234" required /></label>
      <button id="send-code-button" type="submit">Text me a code</button>
    </form> : <form onSubmit={verifyCode}>
      <label>Verification code<input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" required /></label>
      <button type="submit">Sign in</button>
    </form>}
    <div id="recaptcha" />
    {message && <p className="status">{message}</p>}
  </main>;
}
