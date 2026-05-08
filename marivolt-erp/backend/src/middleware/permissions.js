/**
 * Permission middleware — Phase-10.
 *
 * Use after `requireErpAccess` to gate routes by (module, action):
 *
 *     import { requirePermission } from "../middleware/permissions.js";
 *     router.post("/order-allocations/:id/cancel",
 *       ...requireErpAccess,
 *       requirePermission("SALES", "cancel"),
 *       flow.cancelOrderAllocation);
 *
 * Backward compatibility:
 *   - SUPER_ADMIN always passes.
 *   - ADMIN / COMPANY_ADMIN are granted full access by the default
 *     permission matrix in roleService, but they no longer hard-bypass
 *     this middleware. That keeps them configurable in Phase-10.
 *   - When the resolved permission matrix grants the action, the
 *     middleware lets the request proceed.
 *   - Otherwise it returns 403 with code `PERMISSION_DENIED`.
 */
import { hasPermission, normaliseRoleCode } from "../services/roleService.js";

const ALWAYS_ALLOW = new Set(["SUPER_ADMIN"]);

export function requirePermission(moduleName, action) {
  return async function permissionGuard(req, res, next) {
    try {
      const role = normaliseRoleCode(req.user?.role || "");
      if (ALWAYS_ALLOW.has(role)) return next();
      const ok = await hasPermission(req, moduleName, action);
      if (ok) return next();
      return res.status(403).json({
        message: `Permission denied: ${moduleName}.${action}`,
        code: "PERMISSION_DENIED",
      });
    } catch {
      return res.status(403).json({
        message: "Permission check failed",
        code: "PERMISSION_DENIED",
      });
    }
  };
}

export default { requirePermission };
