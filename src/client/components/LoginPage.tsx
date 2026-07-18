import { Bot } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { signInWithGoogle } from '@/lib/firebase';
import { useState } from 'react';
import { useSlots } from '@/lib/slots';

interface LoginPageProps {
  /** Active provider. 'local' → email/password form; 'firebase' → Google. */
  mode?: 'local' | 'firebase' | null;
  /** Local mode with no users yet → create-first-user form. */
  needsSetup?: boolean;
  /** Return an error message, or null on success. */
  onLoginLocal?: (email: string, password: string) => Promise<string | null>;
  onRegisterLocal?: (email: string, password: string) => Promise<string | null>;
}

export function LoginPage({ mode = 'firebase', needsSetup = false, onLoginLocal, onRegisterLocal }: LoginPageProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const isLocal = mode === 'local';
  const slots = useSlots();

  async function handleGoogle() {
    setLoading(true);
    setError('');
    try {
      await signInWithGoogle();
    } catch (e: any) {
      setError(e.message || 'Sign-in failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleLocal(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    const fn = needsSetup ? onRegisterLocal : onLoginLocal;
    const err = fn ? await fn(email.trim(), password) : 'Local auth unavailable';
    if (err) setError(err);
    setLoading(false);
  }

  return (
    <div className="flex h-full items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-6 p-8 rounded-xl border bg-card shadow-sm w-full max-w-sm">
        <div className="flex flex-col items-center gap-2">
          <div className="flex items-center justify-center w-12 h-12 rounded-full bg-primary text-primary-foreground">
            <Bot className="w-6 h-6" />
          </div>
          <h1 className="text-xl font-semibold">Shraga</h1>
          <p className="text-sm text-muted-foreground text-center">
            {isLocal ? (needsSetup ? 'Create your account to get started' : 'Sign in to your agent workspace') : 'Sign in to access the AI agent workspace'}
          </p>
        </div>

        {error && <p className="text-sm text-destructive text-center">{error}</p>}

        {isLocal ? (
          <form onSubmit={handleLocal} className="flex flex-col gap-3 w-full">
            <Input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
            <Input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={needsSetup ? 'new-password' : 'current-password'} required />
            <Button type="submit" disabled={loading || !email || !password} className="w-full">
              {loading ? 'Please wait…' : needsSetup ? 'Create account' : 'Sign in'}
            </Button>
          </form>
        ) : (
          <Button onClick={handleGoogle} disabled={loading} className="w-full">
            {loading ? 'Signing in…' : 'Continue with Google'}
          </Button>
        )}

        {slots.loginExtras?.()}
      </div>
    </div>
  );
}
