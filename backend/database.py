"""数据库连接配置。

当前使用 SQLite 单文件数据库（零安装）；表结构全部采用 MySQL 8.0 兼容写法，
以后切换 MySQL 只需设置环境变量 DATABASE_URL，例如：
    set DATABASE_URL=mysql+pymysql://root:密码@127.0.0.1:3306/campus_books?charset=utf8mb4
并 pip install pymysql，模型代码无需任何修改。
"""
import os

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BACKEND_DIR, "campus_books.db")

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///" + DB_PATH)

engine = create_engine(
    DATABASE_URL,
    # SQLite 需要关闭同线程检查（FastAPI 多线程访问）；MySQL 分支自动忽略
    connect_args={"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {},
    pool_pre_ping=True,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass
