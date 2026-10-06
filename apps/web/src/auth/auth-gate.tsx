import { Button, Panel } from "@figlab/ui";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";

export interface SignedInAccount {
  email: string;
  signOut: () => Promise<void>;
}

const MIN_PASSWORD_LENGTH = 6;

/** Shows sign-in until Supabase reports a session, then renders the app for that account. */
export function AuthGate({
  auth,
  children,
}: {
  auth: SupabaseClient;
  children: (account: SignedInAccount) => ReactNode;
}) {
  const [session, setSession] = useState<Session | null>();
  useEffect(() => {
    let active = true;
    void auth.auth.getSession().then(({ data }) => {
      if (active) setSession(data.session);
    });
    const { data } = auth.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [auth]);

  if (session === undefined)
    return (
      <main className="loading-page">
        <p role="status">Loading…</p>
      </main>
    );
  if (!session?.user.email) return <SignInScreen auth={auth} />;
  return children({
    email: session.user.email,
    signOut: async () => {
      await auth.auth.signOut();
    },
  });
}

type Mode = "sign-in" | "sign-up";
type Notice = { kind: "error" | "info"; text: string; canResend?: boolean };

export function SignInScreen({ auth }: { auth: SupabaseClient }) {
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>();

  const resend = async () => {
    setBusy(true);
    const { error } = await auth.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    setBusy(false);
    setNotice(
      error
        ? { kind: "error", text: error.message, canResend: true }
        : { kind: "info", text: `Verification email sent again to ${email}.` },
    );
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setNotice(undefined);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setNotice({
        kind: "error",
        text: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      });
      return;
    }
    setBusy(true);
    try {
      if (mode === "sign-up") {
        const { data, error } = await auth.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) setNotice({ kind: "error", text: error.message });
        else if (!data.session)
          setNotice({
            kind: "info",
            text: `Check ${email} for a verification link, then sign in.`,
            canResend: true,
          });
        return;
      }
      const { error } = await auth.auth.signInWithPassword({ email, password });
      if (error)
        setNotice(
          error.code === "email_not_confirmed"
            ? {
                kind: "error",
                text: "Verify your email before signing in. Check your inbox for the link.",
                canResend: true,
              }
            : { kind: "error", text: error.message },
        );
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setNotice(undefined);
  };

  return (
    <main className="auth-page">
      <Panel aria-labelledby="auth-heading" className="auth-panel">
        <p className="eyebrow">FigLab</p>
        <h1 id="auth-heading">{mode === "sign-in" ? "Sign in" : "Create an account"}</h1>
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          <label>
            Email
            <input
              autoComplete="email"
              onChange={(event) => setEmail(event.target.value)}
              required
              type="email"
              value={email}
            />
          </label>
          <label>
            Password
            <input
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              minLength={MIN_PASSWORD_LENGTH}
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </label>
          <Button className="primary" disabled={busy} type="submit">
            {mode === "sign-in" ? "Sign in" : "Sign up"}
          </Button>
        </form>
        {notice && (
          <div
            className={`auth-notice ${notice.kind}`}
            role={notice.kind === "error" ? "alert" : "status"}
          >
            <p>{notice.text}</p>
            {notice.canResend && email && (
              <Button disabled={busy} onClick={() => void resend()}>
                Resend verification email
              </Button>
            )}
          </div>
        )}
        <p className="auth-switch">
          {mode === "sign-in" ? "No account yet?" : "Already have an account?"}{" "}
          <button
            className="link-button"
            onClick={() => switchMode(mode === "sign-in" ? "sign-up" : "sign-in")}
            type="button"
          >
            {mode === "sign-in" ? "Create one" : "Sign in"}
          </button>
        </p>
      </Panel>
    </main>
  );
}
