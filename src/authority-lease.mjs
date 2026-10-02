export async function withAuthorityLease(authorityExecutor, options, operation) {
  if (!authorityExecutor || typeof operation !== "function") throw new Error("withAuthorityLease requires authorityExecutor and operation");
  if (typeof authorityExecutor.withAuthority === "function") {
    return authorityExecutor.withAuthority(options, operation);
  }
  const authority = await authorityExecutor.resolveAuthority(options);
  const leaseAccess = options?.access ?? "inherit";
  const lease = {
    nativeLease: false,
    ...authority,
    access: leaseAccess,
    exec: (input = {}) => {
      const access = input.access ?? leaseAccess;
      if (leaseAccess === "readOnly" && access !== "readOnly") {
        throw new Error("read-only authority lease cannot be escalated to inherit");
      }
      return authorityExecutor.exec({
        ...input,
        cwd: authority.effectiveCwd,
        access,
      });
    },
  };
  return operation(lease);
}
