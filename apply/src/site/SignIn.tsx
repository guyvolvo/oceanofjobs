// The signed-out /account and /apply pages: the sign-in alone, as a card.
// The steps and copy are /login's (src/shell/SignIn.tsx).
import { useState } from "react";
import { SignInSteps } from "../shell/SignIn";

export function SignInPage() {
  const [error, setError] = useState("");
  return (
    <div className="mx-auto mt-6 w-full max-w-[420px] rounded-xl border bg-card px-7 pt-8 pb-6">
      <SignInSteps error={error} setError={setError} />
    </div>
  );
}
