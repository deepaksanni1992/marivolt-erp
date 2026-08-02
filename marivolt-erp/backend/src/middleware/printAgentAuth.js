import bcrypt from "bcrypt";
import PrintAgent from "../models/PrintAgent.js";

/**
 * Authenticate Windows Print Agent via:
 *   Authorization: Bearer <secret>
 *   X-Print-Agent-Id: <agentId>
 * Does not use user JWT.
 */
export async function requirePrintAgent(req, res, next) {
  try {
    const agentId = String(req.headers["x-print-agent-id"] || req.body?.agentId || "")
      .trim()
      .toUpperCase();
    const header = req.headers.authorization || "";
    const [type, token] = header.split(" ");
    if (!agentId || type !== "Bearer" || !token) {
      return res.status(401).json({ message: "Missing agent credentials", code: "AGENT_AUTH_REQUIRED" });
    }
    const agent = await PrintAgent.findOne({ agentId, isActive: true });
    if (!agent) {
      return res.status(401).json({ message: "Unknown agent", code: "AGENT_AUTH_FAILED" });
    }
    const ok = await bcrypt.compare(token, agent.secretHash);
    if (!ok) {
      return res.status(401).json({ message: "Invalid agent secret", code: "AGENT_AUTH_FAILED" });
    }
    req.printAgent = agent;
    req.companyId = String(agent.companyId);
    next();
  } catch {
    return res.status(401).json({ message: "Agent authentication failed", code: "AGENT_AUTH_FAILED" });
  }
}
