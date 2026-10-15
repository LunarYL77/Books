"""书籍模块接口：发布 / 我的发布 / 自主下架与重新上架（FR-BOOK-01 / FR-BOOK-02）。

安全要点：
- 发布需登录；图片校验格式与大小后落盘 uploads/；
- 下架 / 重新上架校验 seller_id == 当前用户，防止越权操作他人书籍（NFR 安全）。
"""
import os
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import func, select
from sqlalchemy.orm import Session

import models
from auth import current_user, get_db, optional_user
from config import UPLOAD_DIR

router = APIRouter(tags=["书籍"])

ALLOWED_IMAGE_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
EXT_TO_TYPE = {v: k for k, v in ALLOWED_IMAGE_TYPES.items()}
MAX_IMAGE_BYTES = 5 * 1024 * 1024  # 5MB
MAX_PRICE = 99999


def book_dict(book: models.Book, course_name: str | None = None) -> dict:
    return {
        "book_id": book.book_id,
        "book_name": book.book_name,
        "course_id": book.course_id,
        "course_name": course_name,
        "price": float(book.price),
        "pic_url": book.pic_url,
        "quality_desc": book.quality_desc,
        "status": book.status,
        "created_at": book.created_at.strftime("%Y-%m-%d %H:%M"),
    }


@router.post("/books", summary="发布二手教材（multipart：表单字段 + 实拍图）")
async def create_book(
    book_name: str = Form(...),
    course_id: int = Form(...),
    price: float = Form(...),
    quality_desc: str = Form(default=""),
    image: UploadFile = File(...),
    user: models.User = Depends(current_user),
    db: Session = Depends(get_db),
):
    name = book_name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="请填写书名")
    if len(name) > 100:
        raise HTTPException(status_code=400, detail="书名不能超过 100 个字符")
    if not (0 < price <= MAX_PRICE):
        raise HTTPException(status_code=400, detail="售价需大于 0 且不超过 99999 元")

    course = db.get(models.Course, course_id)
    if course is None:
        raise HTTPException(status_code=400, detail="所选课程不存在，请重新选择")

    # 图片校验：类型白名单（优先 Content-Type，退回扩展名）、大小上限
    ext = ALLOWED_IMAGE_TYPES.get(image.content_type or "")
    if ext is None:
        fn_ext = os.path.splitext(image.filename or "")[1].lower()
        ext = fn_ext if fn_ext in EXT_TO_TYPE else None
    if ext is None:
        raise HTTPException(status_code=400, detail="仅支持 JPG / PNG / WebP 格式图片")
    content = await image.read(MAX_IMAGE_BYTES + 1)
    if len(content) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=400, detail="图片不能超过 5MB，请压缩后重新上传")
    if not content:
        raise HTTPException(status_code=400, detail="图片文件为空，请重新选择")

    fname = uuid.uuid4().hex + ext
    with open(os.path.join(UPLOAD_DIR, fname), "wb") as f:
        f.write(content)

    quality = quality_desc.strip() or None
    if quality and len(quality) > 100:
        raise HTTPException(status_code=400, detail="成色描述不能超过 100 个字符")

    book = models.Book(
        seller_id=user.user_id,
        course_id=course_id,
        book_name=name,
        price=round(price, 2),
        pic_url=f"/uploads/{fname}",
        quality_desc=quality,
        status="上架",
    )
    db.add(book)
    db.commit()
    db.refresh(book)
    return book_dict(book, course.course_name)


@router.get("/books/mine", summary="我发布的全部教材（FR-USER-02）")
def my_books(
    user: models.User = Depends(current_user),
    db: Session = Depends(get_db),
):
    rows = db.execute(
        select(models.Book, models.Course.course_name)
        .join(models.Course, models.Book.course_id == models.Course.course_id)
        .where(models.Book.seller_id == user.user_id)
        .order_by(models.Book.created_at.desc(), models.Book.book_id.desc())
    ).all()
    return [book_dict(b, cn) for b, cn in rows]


ORDER_MAP = {
    "time_desc": (models.Book.created_at.desc(), models.Book.book_id.desc()),
    "price_asc": (models.Book.price.asc(), models.Book.book_id.desc()),
    "price_desc": (models.Book.price.desc(), models.Book.book_id.desc()),
}


@router.get("/books", summary="书市列表：课程筛选 + 书名关键词模糊检索 + 排序（FR-BOOK-03）")
def list_books(
    keyword: str = "",
    course_id: int | None = None,
    sort: str = "time_desc",
    user: models.User | None = Depends(optional_user),
    db: Session = Depends(get_db),
):
    """公开接口：任何人可浏览书市；仅返回上架书籍（上限 200 本）。"""
    filters = [models.Book.status == "上架"]
    kw = keyword.strip()
    if kw:
        filters.append(models.Book.book_name.like(f"%{kw}%"))
    if course_id:
        filters.append(models.Book.course_id == course_id)

    total = db.scalar(select(func.count()).select_from(models.Book).where(*filters))
    rows = db.execute(
        select(models.Book, models.Course.course_name, models.User.username)
        .join(models.Course, models.Book.course_id == models.Course.course_id)
        .join(models.User, models.Book.seller_id == models.User.user_id)
        .where(*filters)
        .order_by(*ORDER_MAP.get(sort, ORDER_MAP["time_desc"]))
        .limit(200)
    ).all()

    collected_ids: set[int] = set()
    if user is not None:
        collected_ids = set(
            db.scalars(
                select(models.Collect.book_id).where(models.Collect.user_id == user.user_id)
            ).all()
        )
    items = [
        {**book_dict(b, cn), "seller_name": un, "collected": b.book_id in collected_ids}
        for b, cn, un in rows
    ]
    return {"total": total or 0, "items": items}


@router.get("/books/{book_id}", summary="教材详情：图片/课程/标价/卖家微信号（FR-BOOK-04）")
def book_detail(
    book_id: int,
    user: models.User | None = Depends(optional_user),
    db: Session = Depends(get_db),
):
    row = db.execute(
        select(models.Book, models.Course.course_name, models.User.username, models.User.wechat)
        .join(models.Course, models.Book.course_id == models.Course.course_id)
        .join(models.User, models.Book.seller_id == models.User.user_id)
        .where(models.Book.book_id == book_id)
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="书籍不存在或已被删除")
    book, course_name, seller_name, seller_wechat = row
    is_owner = user is not None and user.user_id == book.seller_id
    if book.status == "下架" and not is_owner:
        raise HTTPException(status_code=404, detail="该书籍已下架")

    collected = False
    if user is not None:
        collected = (
            db.scalar(
                select(models.Collect).where(
                    models.Collect.user_id == user.user_id,
                    models.Collect.book_id == book_id,
                )
            )
            is not None
        )
    return {
        **book_dict(book, course_name),
        "seller_name": seller_name,
        "seller_wechat": seller_wechat or "",
        "collected": collected,
    }


@router.post("/books/{book_id}/collect", summary="收藏 / 取消收藏（FR-COLLECT-01）")
def toggle_collect(
    book_id: int,
    user: models.User = Depends(current_user),
    db: Session = Depends(get_db),
):
    book = db.get(models.Book, book_id)
    if book is None:
        raise HTTPException(status_code=404, detail="书籍不存在或已被删除")
    if book.status == "下架" and book.seller_id != user.user_id:
        raise HTTPException(status_code=404, detail="该书籍已下架")

    existing = db.scalar(
        select(models.Collect).where(
            models.Collect.user_id == user.user_id,
            models.Collect.book_id == book_id,
        )
    )
    if existing is not None:
        db.delete(existing)
        db.commit()
        return {"collected": False}
    db.add(models.Collect(user_id=user.user_id, book_id=book_id))
    db.commit()
    return {"collected": True}


def _change_status(
    book_id: int,
    user: models.User,
    db: Session,
    target: str,
    already_msg: str,
) -> dict:
    book = db.get(models.Book, book_id)
    if book is None:
        raise HTTPException(status_code=404, detail="书籍不存在或已被删除")
    if book.seller_id != user.user_id:
        raise HTTPException(status_code=403, detail="只能操作自己发布的书籍")
    if book.status == target:
        raise HTTPException(status_code=409, detail=already_msg)
    book.status = target
    db.commit()
    return {"ok": True, "book_id": book.book_id, "status": book.status}


@router.post("/books/{book_id}/delist", summary="自主下架（FR-BOOK-02）")
def delist_book(
    book_id: int,
    user: models.User = Depends(current_user),
    db: Session = Depends(get_db),
):
    return _change_status(book_id, user, db, "下架", "该书籍已经是下架状态")


@router.post("/books/{book_id}/relist", summary="重新上架")
def relist_book(
    book_id: int,
    user: models.User = Depends(current_user),
    db: Session = Depends(get_db),
):
    return _change_status(book_id, user, db, "上架", "该书籍已经是上架状态")
