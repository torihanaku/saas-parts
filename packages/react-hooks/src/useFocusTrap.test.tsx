// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useFocusTrap } from './useFocusTrap';

function Trap({ active }: { active: boolean }) {
  const ref = useFocusTrap(active);
  return (
    <div ref={ref} data-testid="trap">
      <button data-testid="first">first</button>
      <button data-testid="middle">middle</button>
      <button data-testid="last">last</button>
    </div>
  );
}

function pressTab(el: HTMLElement, shiftKey = false) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }));
}

afterEach(cleanup);

describe('useFocusTrap', () => {
  it('focuses the first focusable element when activated', () => {
    const { getByTestId } = render(<Trap active={true} />);
    expect(document.activeElement).toBe(getByTestId('first'));
  });

  it('does nothing when inactive', () => {
    const { getByTestId } = render(<Trap active={false} />);
    expect(document.activeElement).not.toBe(getByTestId('first'));
  });

  it('wraps Tab from the last element back to the first', () => {
    const { getByTestId } = render(<Trap active={true} />);
    getByTestId('last').focus();
    pressTab(getByTestId('trap'));
    expect(document.activeElement).toBe(getByTestId('first'));
  });

  it('wraps Shift+Tab from the first element to the last', () => {
    const { getByTestId } = render(<Trap active={true} />);
    getByTestId('first').focus();
    pressTab(getByTestId('trap'), true);
    expect(document.activeElement).toBe(getByTestId('last'));
  });

  it('restores focus to the trigger element on deactivate', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();

    const { getByTestId, rerender } = render(<Trap active={false} />);
    rerender(<Trap active={true} />);
    expect(document.activeElement).toBe(getByTestId('first'));

    rerender(<Trap active={false} />);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});
