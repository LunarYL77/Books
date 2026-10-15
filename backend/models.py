"""业务实体模型：与需求文档 v1.1 第六节数据模型一一对应。

说明：
- 订单物理表名用 orders（order 是 SQL 保留字）；
- user 表在文档基础上增加 is_admin（FR-REPORT-01 管理员角色）与 created_at；
- 增加 auth_token 登录令牌表（服务端可吊销会话，替代无状态 JWT）。
"""
from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    Enum as SAEnum,
)

from database import Base


class User(Base):
    __tablename__ = "user"

    user_id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(50), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)  # 格式: salt$hash，永不存明文
    wechat = Column(String(50), nullable=True)  # 卖家展示用，选填
    is_admin = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, nullable=False, default=datetime.now)


class Course(Base):
    __tablename__ = "course"

    course_id = Column(Integer, primary_key=True, autoincrement=True)
    course_name = Column(String(100), unique=True, nullable=False)


class Book(Base):
    __tablename__ = "book"

    book_id = Column(Integer, primary_key=True, autoincrement=True)
    seller_id = Column(Integer, ForeignKey("user.user_id"), nullable=False, index=True)
    course_id = Column(Integer, ForeignKey("course.course_id"), nullable=False, index=True)
    book_name = Column(String(200), nullable=False)
    price = Column(Numeric(10, 2), nullable=False)
    pic_url = Column(String(500), nullable=False)  # /uploads/xxx.jpg，本地静态服务
    quality_desc = Column(String(200), nullable=True)  # 成色描述，选填
    status = Column(SAEnum("上架", "下架", name="book_status"), nullable=False, default="上架")
    created_at = Column(DateTime, nullable=False, default=datetime.now)


class Order(Base):
    __tablename__ = "orders"

    order_id = Column(Integer, primary_key=True, autoincrement=True)
    buyer_id = Column(Integer, ForeignKey("user.user_id"), nullable=False, index=True)
    seller_id = Column(Integer, ForeignKey("user.user_id"), nullable=False, index=True)
    book_id = Column(Integer, ForeignKey("book.book_id"), nullable=False)
    order_status = Column(
        SAEnum("待面交", "已取消", "已完成", name="order_status"),
        nullable=False,
        default="待面交",
    )
    create_time = Column(DateTime, nullable=False, default=datetime.now)
    confirm_time = Column(DateTime, nullable=True)


class Collect(Base):
    __tablename__ = "collect"
    __table_args__ = (UniqueConstraint("user_id", "book_id", name="uq_collect_user_book"),)

    collect_id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("user.user_id"), nullable=False)
    book_id = Column(Integer, ForeignKey("book.book_id"), nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.now)


class Report(Base):
    __tablename__ = "report"

    report_id = Column(Integer, primary_key=True, autoincrement=True)
    book_id = Column(Integer, ForeignKey("book.book_id"), nullable=False)
    report_user_id = Column(Integer, ForeignKey("user.user_id"), nullable=False)
    content = Column(Text, nullable=False)
    handle_status = Column(
        SAEnum("待处理", "已处理", name="report_status"), nullable=False, default="待处理"
    )
    created_at = Column(DateTime, nullable=False, default=datetime.now)
    handled_at = Column(DateTime, nullable=True)


class AuthToken(Base):
    """登录会话令牌：服务端存储、可吊销、带过期时间。"""

    __tablename__ = "auth_token"

    token = Column(String(64), primary_key=True)
    user_id = Column(Integer, ForeignKey("user.user_id"), nullable=False, index=True)
    created_at = Column(DateTime, nullable=False, default=datetime.now)
    expires_at = Column(DateTime, nullable=False)
