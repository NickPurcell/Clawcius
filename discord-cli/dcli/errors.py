"""Structured exit codes and the one error type the CLI raises.

Exit codes are a stable contract. An agent branches on them without parsing
prose, so they must not be reassigned once released.
"""

OK = 0
API_ERROR = 1
AUTH_ERROR = 2
VALIDATION_ERROR = 3
CONFIRM_REQUIRED = 4


class CliError(Exception):
    """An error with an exit code and, where possible, a way to recover.

    `remediation` is the important field: it tells the caller what to do next
    rather than only what went wrong.
    """

    def __init__(self, message, code=API_ERROR, remediation=None, details=None):
        super().__init__(message)
        self.message = message
        self.code = code
        self.remediation = remediation
        self.details = details or {}

    def to_dict(self):
        out = {"error": self.message, "exit_code": self.code}
        if self.remediation:
            out["remediation"] = self.remediation
        if self.details:
            out["details"] = self.details
        return out


class AuthError(CliError):
    def __init__(self, message, remediation=None):
        super().__init__(message, AUTH_ERROR, remediation)


class ValidationError(CliError):
    def __init__(self, message, remediation=None):
        super().__init__(message, VALIDATION_ERROR, remediation)
