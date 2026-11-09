// The signed-out /account and /apply pages: the sign-in alone, as a card.
// The steps and copy are the sign-in window's (src/shell/SignIn.tsx); the
// window itself opens from any "Log in" through requestSignIn().
import { useState, type ReactNode } from "react";
import { SignInSteps } from "../shell/SignIn";

const Heading = ({ className, children }: { className?: string; children?: ReactNode }) => <h1 className={className}>{children}</h1>;
const Line = ({ className, children }: { className?: string; children?: ReactNode }) => <p className={className}>{children}</p>;

export function SignInPage() {
  const [error, setError] = useState("");
  return (
    <div className="mx-auto mt-6 w-full max-w-[420px] rounded-xl border bg-card px-7 pt-8 pb-6">
      <SignInSteps error={error} setError={setError} Title={Heading} Description={Line} />
    </div>
  );
}
