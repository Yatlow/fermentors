import { useEffect, useRef, useState, type InputHTMLAttributes } from "react";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange"> & {
    value: number | string | null | undefined;
    onNumberChange: (value: number) => void;
};

/**
 * Numeric inputs backed by numeric domain state still need a temporary empty
 * text state while the user clears the field and types a replacement.
 *
 * We keep that transient draft locally instead of coercing "" to 0. The domain
 * value is only updated when the field contains a valid number. If the user
 * leaves the field empty and blurs it, the last committed domain value returns.
 */
export default function TransientNumberInput({
    value,
    onNumberChange,
    onFocus,
    onBlur,
    ...props
}: Props) {
    const [draft, setDraft] = useState(() => value == null ? "" : String(value));
    const focusedRef = useRef(false);

    useEffect(() => {
        if (!focusedRef.current) {
            setDraft(value == null ? "" : String(value));
        }
    }, [value]);

    return (
        <input
            {...props}
            type="number"
            value={draft}
            onFocus={(event) => {
                focusedRef.current = true;
                onFocus?.(event);
            }}
            onChange={(event) => {
                const raw = event.target.value;
                setDraft(raw);
                if (raw === "") return;

                const parsed = Number(raw);
                if (Number.isFinite(parsed)) onNumberChange(parsed);
            }}
            onBlur={(event) => {
                focusedRef.current = false;
                if (draft === "") {
                    setDraft(value == null ? "" : String(value));
                }
                onBlur?.(event);
            }}
        />
    );
}
