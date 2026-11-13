import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button, Field } from "../components.tsx";
import { api, errorMessage } from "../lib/api.ts";

/**
 * Choose your own 6-digit PIN for this library's kiosk tablet (typed twice,
 * so a slip of the finger doesn't lock you out). PINs are unique in each
 * library, so one already in use there is turned down: you choose another.
 */
export function KioskPinForm({
  libraryName,
  submitLabel = "Save my PIN",
  cancelLabel = "Cancel",
  autoFocus = false,
  onSaved,
  onCancel,
}: {
  libraryName: string;
  submitLabel?: string;
  cancelLabel?: string;
  /** Focus the first box when it appears (opened by a button that's now gone). */
  autoFocus?: boolean;
  onSaved: () => void;
  onCancel?: (() => void) | undefined;
}) {
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [pinError, setPinError] = useState("");
  const [againError, setAgainError] = useState("");
  const [busy, setBusy] = useState(false);
  const pinInput = useRef<HTMLInputElement>(null);
  const againInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) pinInput.current?.focus();
  }, [autoFocus]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setPinError("");
    setAgainError("");
    if (!/^\d{6}$/.test(pin)) {
      setPinError("Your PIN is 6 numbers, like 583920.");
      pinInput.current?.focus();
      return;
    }
    if (again !== pin) {
      setAgainError("The two PINs don't match. Type it again.");
      againInput.current?.focus();
      return;
    }
    setBusy(true);
    try {
      await api("/family/kiosk-code", { body: { pin } });
      setPin("");
      setAgain("");
      onSaved();
    } catch (e) {
      setPinError(errorMessage(e));
      pinInput.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const digitsOnly = (value: string) => value.replace(/\D/g, "").slice(0, 6);
  return (
    <form className="stack" onSubmit={save} noValidate>
      <Field
        ref={pinInput}
        label="Your PIN"
        hint={`6 numbers you'll type on the kiosk at ${libraryName}. Not your birthday, or easy ones like 123456.`}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        // Password managers would offer a long password here, or save the PIN.
        data-1p-ignore
        data-lpignore="true"
        maxLength={6}
        error={pinError}
        value={pin}
        onChange={(e) => setPin(digitsOnly(e.target.value))}
      />
      <Field
        ref={againInput}
        label="Type your PIN again"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
        maxLength={6}
        error={againError}
        value={again}
        onChange={(e) => setAgain(digitsOnly(e.target.value))}
      />
      <div className="row">
        <Button type="submit" busy={busy} busyLabel="Saving…">
          {submitLabel}
        </Button>
        {onCancel && (
          <Button variant="secondary" onClick={onCancel}>
            {cancelLabel}
          </Button>
        )}
      </div>
    </form>
  );
}
