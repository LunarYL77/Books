"""FastAPI 入口：注册路由、静态资源、建表、种子课程、统一异常格式。"""
import os

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select

import models  # noqa: F401  导入即注册全部表模型
from config import UPLOAD_DIR, WEB_DIR
from database import Base, SessionLocal, engine
from routers.books import router as books_router
from routers.courses import router as courses_router
from routers.users import router as users_router

os.makedirs(os.path.join(WEB_DIR, "vendor"), exist_ok=True)
os.makedirs(UPLOAD_DIR, exist_ok=True)

# 校内常见课程分类（首次启动时写入 course 表作为分类维度，仅此一处种子数据）
DEFAULT_COURSES = [
    "高等数学", "线性代数", "概率论与数理统计", "离散数学", "大学物理",
    "大学英语", "大学语文", "C语言程序设计", "Python程序设计", "数据结构",
    "操作系统", "计算机网络", "计算机组成原理", "数据库原理", "电路分析基础",
    "有机化学", "微观经济学", "会计学原理", "管理学原理", "马克思主义基本原理",
]


def seed_courses() -> None:
    db = SessionLocal()
    try:
        if db.scalar(select(models.Course).limit(1)) is None:
            db.add_all([models.Course(course_name=n) for n in DEFAULT_COURSES])
            db.commit()
    finally:
        db.close()


app = FastAPI(title="本校大学生二手教材教辅交易平台", version="1.1.0-m2")

# 启动即建表 + 种子课程（幂等）
Base.metadata.create_all(engine)
seed_courses()

app.include_router(users_router, prefix="/api")
app.include_router(courses_router, prefix="/api")
app.include_router(books_router, prefix="/api")


@app.exception_handler(RequestValidationError)
async def validation_handler(request: Request, exc: RequestValidationError):
    """把 Pydantic 校验错误翻译成用户能看懂的中文提示。"""
    msgs = []
    for e in exc.errors():
        field = "/".join(str(x) for x in e["loc"][1:])
        if e["type"] == "string_too_short":
            msgs.append(f"{field} 长度不足")
        elif e["type"] == "string_too_long":
            msgs.append(f"{field} 超出长度限制")
        else:
            msgs.append(f"{field}: {e['msg']}")
    return JSONResponse(status_code=422, content={"detail": "；".join(msgs) or "表单校验未通过"})


# 静态资源：前端页面、本地化依赖库、前端脚本、教材实拍图
app.mount("/vendor", StaticFiles(directory=os.path.join(WEB_DIR, "vendor")), name="vendor")
app.mount("/js", StaticFiles(directory=os.path.join(WEB_DIR, "js")), name="js")
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(os.path.join(WEB_DIR, "index.html"))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="warning")
