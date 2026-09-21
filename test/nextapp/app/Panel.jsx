'use client';
import { useState } from 'react';
import { save } from './actions';

export default function Panel() {
  const [count, setCount] = useState(0);
  const [msg, setMsg] = useState('');
  return (
    <section>
      <button id="count" onClick={() => setCount(count + 1)}>Clicked {count} times</button>
      <button id="save" onClick={async () => setMsg(await save('plan'))} style={{ marginLeft: 12 }}>Save plan</button>
      <p id="msg">{msg}</p>
    </section>
  );
}
