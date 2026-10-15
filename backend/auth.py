"""认证与授权：密码哈希（PBKDF2-SHA256）、会话令牌、当前用户依赖。

安全要点（对应 NFR）：
- 密码加盐哈希后存储，验证使用常数时间比较；
- 令牌放服务端 auth_token 表，可主动吊销（退出登录即失效）；
- 所有需要登录的接口通过 current_user 依赖统一校验，天然防止越权。
"""
import hashlib
import os
import secrets
from datetime import datetime, timedelta

from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session

import models
from database import SessionLocal

PBKDF2_ROUNDS = 200_000
TOKEN_DAYS = 7


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ROUNDS)
    return salt.hex() + "$" + dk.hex()


def verify_password(password: str, stored: str) -> bool:
    try:
        salt_hex, dk_hex = stored.split("$")
        dk = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), PBKDF2_ROUNDS
        )
        return secrets.compare_digest(dk.hex(), dk_hex)
    except Exception:
        return False


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def create_token(user_id: int, db: Session) -> str:
    token = secrets.token_urlsafe(32)[:63]
    db.add(
        models.AuthToken(
            token=token,
            user_id=user_id,
            expires_at=datetime.now() + timedelta(days=TOKEN_DAYS),
        )
    )
    db.commit()
    return token


def revoke_token(token: str, db: Session) -> None:
    db.query(models.AuthToken).filter(models.AuthToken.token == token).delete()
    db.commit()


def current_user(
    x_token: str = Header(default=""), db: Session = Depends(get_db)
) -> models.User:
    if not x_token:
        raise HTTPException(status_code=401, detail="未登录或登录已过期")
    row = db.get(models.AuthToken, x_token)
    if row is None or row.expires_at < datetime.now():
        raise HTTPException(status_code=401, detail="未登录或登录已过期")
    user = db.get(models.User, row.user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="账号不存在")
    return user


def optional_user(
    x_token: str = Header(default=""), db: Session = Depends(get_db)
) -> models.User | None:
    """公开接口用：带有效令牌则返回用户，否则返回 None（不抛 401）。"""
    if not x_token:
        return None
    row = db.get(models.AuthToken, x_token)
    if row is None or row.expires_at < datetime.now():
        return None
    return db.get(models.User, row.user_id)
