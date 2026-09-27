import { useState } from "react";

interface Props {
  masterKey: string;
  onChange: (key: string) => void;
}

/**
 * The account master key never touches the broker, so there's no API call
 * that can fetch it for you — it has to come from a device that already
 * has it. Right now that means copying it from the phone app's "Show
 * master key" screen. A real QR-code pairing exchange (rather than
 * copy/pasting a raw key) is the natural next step before this ships to
 * anyone but yourself.
 */
export function MasterKeyPanel({ masterKey, onChange }: Props) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="card">
      <h2>Master key</h2>
      <p className="muted">
        Needed to decrypt downloads. Copy it from the phone app's "Show master key" screen —
        it's the same key that phone used to wrap each file's encryption key.
      </p>
      <input
        placeholder="Paste the master key from your phone"
        type={visible ? "text" : "password"}
        value={masterKey}
        onChange={(e) => onChange(e.target.value)}
      />
      <button type="button" className="secondary" onClick={() => setVisible(!visible)}>
        {visible ? "Hide" : "Show"}
      </button>
    </div>
  );
}
