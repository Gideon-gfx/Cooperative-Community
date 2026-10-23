import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { api, errMsg } from '../api/client';
import { useAuth } from '../auth/AuthContext';

const emailSchema = z.object({
  email: z.string().trim().email('Enter a valid email address').max(254),
  password: z.string().min(8, 'Use at least 8 characters').max(128),
  fullName: z.string().trim().min(2, 'Enter your full name').optional().or(z.literal('')),
  phoneNumber: z.string().trim().min(7, 'Enter a valid phone number').max(20).or(z.literal('')),
  country: z.enum(['NG', 'GH', 'KE']),
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
  const [emailMode, setEmailMode] = useState<'login' | 'register'>('login');
  const { login } = useAuth();
  const navigate = useNavigate();

  const emailForm = useForm<z.infer<typeof emailSchema>>({
    resolver: zodResolver(emailSchema),
    defaultValues: { phoneNumber: '', country: 'NG' },
  });

  const submitEmail = emailForm.handleSubmit(async ({ email, password, fullName, phoneNumber, country }) => {
    if (emailMode === 'register' && !phoneNumber.trim()) {
      emailForm.setError('phoneNumber', { type: 'required', message: 'Phone number is required' });
      return;
    }
    try {
      const path = emailMode === 'register' ? '/auth/register' : '/auth/login-email';
      const body = emailMode === 'register'
        ? { email, password, fullName, phoneNumber, role, country }
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
              {emailMode === 'register' && (
                <>
                  <div>
                    <label className="block font-semibold" htmlFor="country">Country</label>
                    <select id="country" className="input" {...emailForm.register('country')}>
                      <option value="NG">Nigeria</option>
                      <option value="GH">Ghana</option>
                      <option value="KE">Kenya</option>
                    </select>
                  </div>
                  <div>
                    <label className="block font-semibold" htmlFor="phoneNumber">Phone number</label>
                    <input id="phoneNumber" className="input" type="tel" autoComplete="tel" required placeholder="0803 123 4567" {...emailForm.register('phoneNumber')} />
                    {emailForm.formState.errors.phoneNumber && <p className="text-warning">{emailForm.formState.errors.phoneNumber.message}</p>}
                    <p className="mt-1 text-sm text-gray-600">No SMS verification code is needed.</p>
                  </div>
                </>
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
              <button className="btn-primary w-full" disabled={emailForm.formState.isSubmitting}>
                {emailMode === 'register' ? 'Create account' : 'Log in'}
              </button>
            </form>
            {emailMode === 'register' && role === 'COLLECTOR' && <p className="text-sm text-gray-600">Collector accounts must be approved by the platform before creating groups.</p>}
        </>
      </div>
    </div>
  );
}
