"""Transport-agnostic error taxonomy for the chat backends.

Both transports — the direct GigaChat mTLS client (:mod:`app.gigachat`) and the
KitAI polling client (:mod:`app.kitai`) — raise these. The chat route maps them
to SSE ``error`` frames by ``code``, so the SSE contract does not change when the
provider does.

The ``GigaChat*`` names are kept verbatim rather than renamed to something
neutral: they are the codes the frontend and the saved chat history already
carry, and a rename would only churn every call site and every stored turn for
no behavioural gain. Read them as "chat backend error", not "GigaChat-specific".
"""

from __future__ import annotations


class GigaChatError(Exception):
    """Base class for chat-backend errors carrying an SSE-ready code/message/detail."""

    def __init__(self, code: str, message: str, detail: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail

    def __str__(self) -> str:
        """Message AND detail.

        Every caller logs the exception with ``%s``, and ``Exception.__str__``
        returns only the message — so the one field that says WHY (the platform's
        own error text, the HTTP body) was carried all the way to the log and
        dropped there. Observed in production as three identical lines reading
        «KitAI завершил запрос со статусом "error"» with no cause anywhere.
        """
        return f"{self.message} — {self.detail}" if self.detail else self.message


class GigaChatCertMissing(GigaChatError):
    """Client cert or key file is absent — surfaced as a pre-flight 400."""


class GigaChatDNS(GigaChatError):
    pass


class GigaChatTLS(GigaChatError):
    pass


class GigaChatHTTP(GigaChatError):
    pass


class GigaChatStreamDropped(GigaChatError):
    pass


class GigaChatBadJSON(GigaChatError):
    """The model's answer did not contain a parseable JSON *object*."""


class KitaiPollingTimeout(GigaChatError):
    """The query never reached ``finished`` inside the polling budget.

    Distinct from a transport failure: the request WAS accepted and may still be
    running on the platform side, so the operator reads this as "raise the
    timeout / the model is slow", not "the connection is broken".
    """


class KitaiQueryFailed(GigaChatError):
    """The platform reported a final, non-successful query state."""
