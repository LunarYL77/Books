"""接口出入参模型（Pydantic）。"""
from typing import Optional

from pydantic import BaseModel, Field


class RegisterIn(BaseModel):
    username: str = Field(min_length=2, max_length=20, description="账号名")
    password: str = Field(min_length=6, max_length=64, description="密码，不少于 6 位")
    wechat: Optional[str] = Field(default=None, max_length=50, description="微信号，选填")


class LoginIn(BaseModel):
    username: str
    password: str
