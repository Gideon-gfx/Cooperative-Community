import { Link, useNavigate } from 'react-router-dom';
import { Coins, ShoppingBasket } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';

export default function Landing() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const go = (role: string) => navigate(user ? '/dashboard' : `/auth?role=${role}`);

  return (
    <div className="flex min-h-screen flex-col">
      <main className="flex flex-1 flex-col">
        <section className="flex flex-1 flex-col items-start justify-center gap-4 bg-primary px-6 py-12 text-white sm:px-16">
          <Coins size={40} className="text-accent" />
          <h1 className="text-4xl">ÀJỌ — Money</h1>
          <p className="max-w-xl text-xl text-white/90">Digitize your rotational savings with your community.</p>
          <button className="btn-accent text-lg" onClick={() => go('COLLECTOR')}>Start an Àjọ Group</button>
        </section>
        <section className="flex flex-1 flex-col items-start justify-center gap-4 bg-accent px-6 py-12 text-gray-900 sm:px-16">
          <ShoppingBasket size={40} className="text-primary" />
          <h1 className="text-4xl">ÀJỌ — Food</h1>
          <p className="max-w-xl text-xl">Pool together to buy food factory-direct. Beat inflation.</p>
          <button className="btn-primary text-lg" onClick={() => go('MEMBER')}>Join a Food Pool</button>
        </section>
      </main>
      <footer className="flex items-center justify-between bg-gray-900 px-6 py-5 text-gray-300 sm:px-16">
        <span>© ÀJỌ Community Co-operative</span>
        <Link to="/auth" className="inline-flex min-h-tap items-center font-semibold text-accent underline">
          {user ? 'Go to dashboard' : 'Log in'}
        </Link>
      </footer>
    </div>
  );
}
