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

/** Pass if the user has any one of the listed module.action permissions. */
export function requireAnyPermission(...checks) {
  const pairs = checks.map(([moduleName, action]) => [moduleName, action]);
  return async function anyPermissionGuard(req, res, next) {
    try {
      const role = normaliseRoleCode(req.user?.role || "");
      if (ALWAYS_ALLOW.has(role)) return next();
      for (const [moduleName, action] of pairs) {
        if (await hasPermission(req, moduleName, action)) return next();
      }
      const label = pairs.map(([m, a]) => `${m}.${a}`).join(" | ");
      return res.status(403).json({
        message: `Permission denied: requires one of ${label}`,
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

/**
 * Explicitly deny listed roles even if a coarser permission would otherwise pass.
 * Used to keep STORE_OPERATOR off stock adjustment / dispatch / repair surfaces
 * that share STORE.create with GRN/packing drafts.
 */
export function denyRoles(...roleCodes) {
  const denied = new Set(
    roleCodes
      .flat()
      .map((r) => normaliseRoleCode(r))
      .filter(Boolean)
  );
  return function denyRolesGuard(req, res, next) {
    const role = normaliseRoleCode(req.user?.role || "");
    if (role && denied.has(role)) {
      return res.status(403).json({
        message: "Permission denied for this role",
        code: "PERMISSION_DENIED",
      });
    }
    return next();
  };
}

export default { requirePermission, requireAnyPermission, denyRoles };
