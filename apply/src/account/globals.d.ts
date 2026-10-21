// What /auth.js (a classic script loaded before the bundle) puts in the
// global scope. The account page signs in with these, as every other
// page does, rather than with a second copy of the Cognito details.
declare function avatarHtml(email: string, idToken: string): string;
declare function decodeJwtEmail(idToken: string): string | null;
declare function decodeJwtName(idToken: string): string | null;
declare function startGoogleSignIn(): Promise<void>;
declare function startGithubSignIn(): void;
declare function startEmailSignIn(email: string): Promise<void>;
declare function verifyEmailOtp(code: string): Promise<void>;
declare function verifyCodeError(err: unknown): string;
declare const SEND_CODE_FAILED: string;
declare function setAuthErrorSink(fn: (msg: string) => void): void;
declare function setAuthRenderSink(fn: () => void): void;
declare let authRenderSink: () => void;
declare function handleAuthRedirect(): Promise<void>;
declare function signOut(): void;
declare function getAuthTokens(): { id_token: string; access_token: string; refresh_token: string } | null;
