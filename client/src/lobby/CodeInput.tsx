import { useState } from 'react';

/**
 * Number of characters in a room code, mirroring the server's
 * `ROOM_CODE_LENGTH` (see `server/lobby/rooms.ts`). The two workspaces don't
 * share a package, so this is kept in sync by hand.
 */
export const CODE_LENGTH = 4;

/** Keep only the characters a room code can contain (see `ROOM_CODE_ALPHABET`). */
function sanitize(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, CODE_LENGTH);
}

/**
 * A segmented room-code entry, matching screen 01 of the mockup: one glowing
 * box per character. A single transparent `<input>` overlays the boxes so the
 * native (mobile) keyboard, paste, and assistive tech all work off one field —
 * the boxes are a purely visual reflection of its value.
 */
export default function CodeInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const chars = value.split('');

  return (
    <div className="code-input">
      <div className="code-input__boxes" aria-hidden="true">
        {Array.from({ length: CODE_LENGTH }, (_, i) => {
          const filled = i < value.length;
          // Highlight the next empty box while the field has focus, so the
          // caret's position is obvious even though the real caret is hidden.
          const active = focused && !disabled && i === value.length && value.length < CODE_LENGTH;
          const className = [
            'code-box',
            filled ? 'code-box--filled' : '',
            active ? 'code-box--active' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <div key={i} className={className}>
              {chars[i] ?? ''}
            </div>
          );
        })}
      </div>
      <input
        className="code-input__field"
        value={value}
        onChange={(e) => onChange(sanitize(e.target.value))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        inputMode="text"
        autoComplete="off"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        maxLength={CODE_LENGTH}
        aria-label="Room code"
        disabled={disabled}
      />
    </div>
  );
}
