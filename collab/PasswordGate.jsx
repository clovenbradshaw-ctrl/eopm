import { useState } from 'react';
import { GATE_PASSWORD, GATE_FLAG_KEY } from './constants.js';

export default function PasswordGate({ onPass }) {
  const [value, setValue] = useState('');
  const [wrong, setWrong] = useState(false);

  function submit(e) {
    e.preventDefault();
    if (value.trim() === GATE_PASSWORD) {
      try { localStorage.setItem(GATE_FLAG_KEY, '1'); } catch {}
      onPass();
    } else {
      setWrong(true);
    }
  }

  return (
    <div className="gate">
      <form onSubmit={submit}>
        <div className="gate-label">Enter the password to continue</div>
        <input
          autoFocus
          type="password"
          value={value}
          onChange={(e) => { setValue(e.target.value); setWrong(false); }}
        />
        <button type="submit">Continue</button>
        {wrong && <div className="gate-error">That's not it.</div>}
      </form>
    </div>
  );
}
