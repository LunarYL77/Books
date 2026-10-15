"""课程模块接口：课程列表（发布绑课与首页分类共用）。"""
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

import models
from auth import get_db

router = APIRouter(tags=["课程"])


@router.get("/courses", summary="课程列表")
def list_courses(db: Session = Depends(get_db)):
    rows = db.scalars(select(models.Course).order_by(models.Course.course_id)).all()
    return [{"course_id": c.course_id, "course_name": c.course_name} for c in rows]
