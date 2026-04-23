import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";

export default function ProtectedRoute() {
  const { isLoggedIn, requiresCompanySelection } = useAuth();
  if (requiresCompanySelection) {
    return <Navigate to="/select-company" replace />;
  }
  if (!isLoggedIn) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
