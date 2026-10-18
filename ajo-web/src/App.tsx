import { Navigate, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from './auth/AuthContext';
import Landing from './pages/Landing';
import AuthPage from './pages/AuthPage';
import GroupChat from './pages/GroupChat';
import AjoPool from './pages/AjoPool';
import FoodPool from './pages/FoodPool';
import Dashboard from './pages/Dashboard';

function Protected({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return user ? <>{children}</> : <Navigate to="/auth" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/auth" element={<AuthPage />} />
      <Route path="/dashboard" element={<Protected><Dashboard /></Protected>} />
      <Route path="/groups/:id" element={<Protected><GroupChat /></Protected>} />
      <Route path="/ajo/:poolId" element={<Protected><AjoPool /></Protected>} />
      <Route path="/food/:poolId" element={<Protected><FoodPool /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
