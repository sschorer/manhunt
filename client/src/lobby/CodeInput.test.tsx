import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import CodeInput, { CODE_LENGTH } from './CodeInput.tsx';

afterEach(cleanup);

/** A tiny controlled harness so typing flows through the parent, as in the app. */
function Harness({ onChange }: { onChange?: (v: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <CodeInput
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

describe('<CodeInput />', () => {
  it('renders one box per code character', () => {
    render(<Harness />);
    // The single accessible field plus CODE_LENGTH visual boxes.
    expect(screen.getByLabelText(/room code/i)).toBeInTheDocument();
  });

  it('upper-cases input and drops disallowed characters', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.type(screen.getByLabelText(/room code/i), 'a2-!z');
    expect(onChange).toHaveBeenLastCalledWith('A2Z');
    expect(screen.getByLabelText(/room code/i)).toHaveValue('A2Z');
  });

  it('caps the value at the code length', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(screen.getByLabelText(/room code/i), 'ABCDEFGH');
    expect(screen.getByLabelText(/room code/i)).toHaveValue('ABCD'.slice(0, CODE_LENGTH));
  });
});
