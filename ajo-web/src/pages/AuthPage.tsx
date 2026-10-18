import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { api, errMsg } from '../api/client';
import { useAuth } from '../auth/AuthContext';

const phoneSchema = z.object({
  phoneNumber: z.string().regex(/^(?:\+?234|0)[789][01]\d{8}$/, 'Enter a valid Nigerian phone number'),
});
const otpSchema = z.object({
  otp: z.string().length(6, 'Enter the 6-digit code'),
  fullName: z.string().min(2, 'Enter your full name').optional().or(z.literal('')),
});
const emailSchema = z.object({
  email: z.string().trim().email('Enter a valid email address').max(254),
  password: z.string().min(8, 'Use at least 8 characters').max(128),
  fullName: z.string().trim().min(2, 'Enter your full name').optional().or(z.literal('')),
});

const ROLES = [
  { value: 'MEMBER', label: 'Member' },
  { value: 'COLLECTOR', label: 'Collector / Baba Àlàjọ' },
  { value: 'TRANSPORTER', label: 'Transporter' },
] as const;

export default function AuthPage() {
  const [params] = useSearchParams();
  const initialRole = ROLES.find((r) => r.value === params.get('role'))?.value ?? 'MEMBER';
  const [role, setRole] = useState<string>(initialRole);
  const [authMode, setAuthMode] = useState<'phone' | 'email'>('phone');
  const [emailMode, setEmailMode] = useState<'login' | 'register'>('login');
  const [phone, setPhone] = useState<string | null>(null);
  const { login } = useAuth();
  const navigate = useNavigate();

  const phoneForm = useForm<z.infer<typeof phoneSchema>>({ resolver: zodResolver(phoneSchema) });
  const otpForm = useForm<z.infer<typeof otpSchema>>({ resolver: zodResolver(otpSchema) });
  const emailForm = useForm<z.infer<typeof emailSchema>>({ resolver: zodResolver(emailSchema) });

  const requestOtp = phoneForm.handleSubmit(async ({ phoneNumber }) => {
    try {
      await api.post('/auth/request-otp', { phoneNumber });
      setPhone(phoneNumber);
      toast.success('Code sent by SMS');
    } catch (e) {
      toast.error(errMsg(e));
    }
  });

  const verify = otpForm.handleSubmit(async ({ otp, fullName }) => {
    try {
      const { data } = await api.post('/auth/verify-otp', { phoneNumber: phone, otp, fullName: fullName || undefined, role });
      login(data.token, data.user);
      navigate('/dashboard');
    } catch (e) {
      toast.error(errMsg(e));
    }
  });

  const submitEmail = emailForm.handleSubmit(async ({ email, password, fullName }) => {
    try {
      const path = emailMode === 'register' ? '/auth/register' : '/auth/login-email';
      const body = emailMode === 'register'
        ? { email, password, fullName, role, country: 'NG' }
        : { email, password };
      const { data } = await api.post(path, body);
      login(data.token, data.user);
      navigate('/dashboard');
    } catch (e) {
      toast.error(errMsg(e));
    }
  });

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-5 py-10">
      <h1 className="text-center text-primary">ÀJỌ</h1>
      <div className="card space-y-5">
        <div className="grid grid-cols-2 gap-2">
          {([{ value: 'phone', label: 'Phone + SMS' }, { value: 'email', label: 'Email + password' }] as const).map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setAuthMode(option.value)}
              className={`min-h-tap rounded-xl border-2 px-4 py-3 font-semibold ${authMode === option.value ? 'border-primary bg-primary-light text-primary' : 'border-gray-200'}`}
            >
              {option.label}
            </button>
          ))}
        </div>

        {authMode === 'email' ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              {([{ value: 'login', label: 'Log in' }, { value: 'register', label: 'Create account' }] as const).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => emailMode !== option.value && setEmailMode(option.value)}
                  className={`min-h-tap rounded-xl border-2 px-4 py-3 font-semibold ${emailMode === option.value ? 'border-primary bg-primary-light text-primary' : 'border-gray-200'}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {emailMode === 'register' && (
              <div>
                <p className="mb-2 font-semibold">I am a…</p>
                <div className="grid gap-2">
                  {ROLES.map((r) => (
                    <button
                      key={r.value}
                      type="button"
                      onClick={() => setRole(r.value)}
                      className={`min-h-tap rounded-xl border-2 px-4 py-3 text-left font-semibold ${role === r.value ? 'border-primary bg-primary-light text-primary' : 'border-gray-200'}`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <form onSubmit={submitEmail} className="space-y-3">
              {emailMode === 'register' && (
                <div>
                  <label className="block font-semibold" htmlFor="fullName">Full name</label>
                  <input id="fullName" className="input" autoComplete="name" {...emailForm.register('fullName')} />
                  {emailForm.formState.errors.fullName && <p className="text-warning">{emailForm.formState.errors.fullName.message}</p>}
                </div>
              )}
              <div>
                <label className="block font-semibold" htmlFor="email">Email address</label>
                <input id="email" className="input" type="email" autoComplete="email" placeholder="you@gmail.com" {...emailForm.register('email')} />
                {emailForm.formState.errors.email && <p className="text-warning">{emailForm.formState.errors.email.message}</p>}
              </div>
              <div>
                <label className="block font-semibold" htmlFor="password">Password</label>
                <input id="password" className="input" type="password" autoComplete={emailMode === 'register' ? 'new-password' : 'current-password'} {...emailForm.register('password')} />
                {emailForm.formState.errors.password && <p className="text-warning">{emailForm.formState.errors.password.message}</p>}
              </div>
              {emailMode === 'register' && <p className="text-sm text-gray-600">A phone number is optional. Phone-based SMS and USSD features need one.</p>}
              <button className="btn-primary w-full" disabled={emailForm.formState.isSubmitting}>
                {emailMode === 'register' ? 'Create account' : 'Log in'}
              </button>
            </form>
            {emailMode === 'register' && role === 'COLLECTOR' && <p className="text-sm text-gray-600">Collector accounts must be approved by the platform before creating groups.</p>}
          </>
        ) : (
          <>
            {!phone && (
              <div>
                <p className="mb-2 font-semibold">I am a…</p>
                <div className="grid gap-2">
                  {ROLES.map((r) => (
                    <button
                      key={r.value}
                      type="button"
                      onClick={() => setRole(r.value)}
                      className={`min-h-tap rounded-xl border-2 px-4 py-3 text-left font-semibold ${role === r.value ? 'border-primary bg-primary-light text-primary' : 'border-gray-200'}`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {!phone ? (
              <form onSubmit={requestOtp} className="space-y-3">
                <label className="block font-semibold" htmlFor="phone">Phone number</label>
                <input id="phone" className="input" inputMode="tel" placeholder="0803 123 4567" {...phoneForm.register('phoneNumber')} />
                {phoneForm.formState.errors.phoneNumber && <p className="text-warning">{phoneForm.formState.errors.phoneNumber.message}</p>}
                <button className="btn-primary w-full" disabled={phoneForm.formState.isSubmitting}>Send code</button>
              </form>
            ) : (
              <form onSubmit={verify} className="space-y-3">
                <p>Code sent to <b>{phone}</b></p>
                <input className="input text-center text-2xl tracking-widest" inputMode="numeric" maxLength={6} placeholder="••••••" {...otpForm.register('otp')} />
                {otpForm.formState.errors.otp && <p className="text-warning">{otpForm.formState.errors.otp.message}</p>}
                <input className="input" placeholder="Full name (new accounts)" {...otpForm.register('fullName')} />
                <button className="btn-primary w-full" disabled={otpForm.formState.isSubmitting}>Verify & continue</button>
                <button type="button" className="btn w-full text-gray-600" onClick={() => setPhone(null)}>Use a different number</button>
              </form>
            )}
            {role === 'COLLECTOR' && <p className="text-sm text-gray-600">Collector accounts must be approved by the platform before creating groups.</p>}
          </>
        )}
      </div>
    </div>
  );
}
