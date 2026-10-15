"""用户模块接口：注册 / 登录 / 当前用户 / 退出（FR-USER-01）。"""
from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

import models
from auth import create_token, current_user, get_db, hash_password, revoke_token, verify_password
from schemas import LoginIn, RegisterIn

router = APIRouter(prefix="/auth", tags=["用户"])


def user_dict(u: models.User) -> dict:
    return {
        "user_id": u.user_id,
        "username": u.username,
        "wechat": u.wechat,
        "is_admin": bool(u.is_admin),
        "created_at": u.created_at.strftime("%Y-%m-%d %H:%M"),
    }


@router.post("/register", summary="注册")
def register(body: RegisterIn, db: Session = Depends(get_db)):
    username = body.username.strip()
    wechat = body.wechat.strip() if body.wechat and body.wechat.strip() else None
    if db.scalar(select(models.User).where(models.User.username == username)):
        raise HTTPException(status_code=409, detail="用户名已被注册，请换一个")
    user = models.User(
        username=username,
        password_hash=hash_password(body.password),
        wechat=wechat,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    token = create_token(user.user_id, db)
    return {"token": token, "user": user_dict(user)}


@router.post("/login", summary="登录")
def login(body: LoginIn, db: Session = Depends(get_db)):
    user = db.scalar(select(models.User).where(models.User.username == body.username.strip()))
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    token = create_token(user.user_id, db)
    return {"token": token, "user": user_dict(user)}


@router.get("/me", summary="当前登录用户")
def me(user: models.User = Depends(current_user)):
    return user_dict(user)


@router.post("/logout", summary="退出登录（吊销令牌）")
def logout(
    x_token: str = Header(default=""),
    user: models.User = Depends(current_user),
    db: Session = Depends(get_db),
):
    if x_token:
        revoke_token(x_token, db)
    return {"ok": True}
