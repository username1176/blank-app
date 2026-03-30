"""
JWT authentication dependency for FastAPI routes.

Extracts and verifies a Bearer token from the Authorization header.
The token payload must contain ``sub`` (user ID) and ``customerId`` (tenant).
All other claims are optional.

Usage
-----
    from src.middleware.auth import AuthPayload, get_current_user

    @router.post("/predict")
    async def predict(auth: AuthPayload = Depends(get_current_user)):
        customer_id = auth.customer_id
        ...
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import ExpiredSignatureError, JWTError, jwt

from src.config import get_settings

# FastAPI security scheme — sets WWW-Authenticate header automatically.
_bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class AuthPayload:
    """Validated claims extracted from the JWT."""
    user_id:     str
    customer_id: str
    email:       str | None


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> AuthPayload:
    """
    FastAPI dependency.  Raises HTTP 401 on any auth failure.

    Validations performed
    ---------------------
    - Authorization header present and scheme is Bearer.
    - Signature valid against JWT_SECRET.
    - Token not expired (exp claim).
    - Audience matches JWT_AUDIENCE when configured.
    - Issuer  matches JWT_ISSUER  when configured.
    - Payload contains required claims: ``sub``, ``customerId``.
    """
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "MISSING_TOKEN", "message": "Authorization header required"},
            headers={"WWW-Authenticate": "Bearer"},
        )

    settings = get_settings()

    options: dict = {"verify_exp": True}
    kwargs: dict = {
        "algorithms": [settings.JWT_ALGORITHM],
        "options": options,
    }
    if settings.JWT_AUDIENCE:
        kwargs["audience"] = settings.JWT_AUDIENCE
    if settings.JWT_ISSUER:
        kwargs["issuer"] = settings.JWT_ISSUER

    try:
        payload: dict = jwt.decode(
            credentials.credentials,
            settings.JWT_SECRET,
            **kwargs,
        )
    except ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "TOKEN_EXPIRED", "message": "Token has expired"},
            headers={"WWW-Authenticate": "Bearer error=\"invalid_token\""},
        )
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "TOKEN_INVALID", "message": "Token is invalid"},
            headers={"WWW-Authenticate": "Bearer error=\"invalid_token\""},
        )

    user_id     = payload.get("sub")
    customer_id = payload.get("customerId")

    if not user_id or not customer_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "TOKEN_MISSING_CLAIMS",
                "message": "Token must contain 'sub' and 'customerId' claims",
            },
        )

    return AuthPayload(
        user_id=str(user_id),
        customer_id=str(customer_id),
        email=payload.get("email"),
    )
