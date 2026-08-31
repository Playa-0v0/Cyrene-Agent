# OpenXML 子元素顺序规则

OpenXML 中的元素顺序由 XSD schema 定义。顺序错误会产生无效文档，Word 可能拒绝打开或静默修复（可能导致数据丢失）。

> **关键规则**：属性元素（`*Pr`）必须始终是其父元素的**第一个子元素**。

---

## w:document

```
子元素顺序：
1. w:background       [0..1]  — 页面背景色/填充
2. w:body              [0..1]  — 文档内容容器
```

---

## w:body

```
子元素顺序（重复组）：
1. w:p                 [0..*]  — 段落
2. w:tbl               [0..*]  — 表格
3. w:sdt               [0..*]  — 结构化文档标签（内容控件）
4. w:sectPr            [0..1]  — 最后一个子元素：末节属性
```

注意：`w:p`、`w:tbl` 和 `w:sdt` 按文档顺序交替出现。唯一的严格规则是 `w:sectPr` 必须是 `w:body` 的**最后一个子元素**。

---

## w:p（段落）

```
子元素顺序：
1. w:pPr               [0..1]  — 段落属性（必须为第一个）

然后是以下任意组合（按文档顺序交替）：
- w:r                  [0..*]  — run（文本运行）
- w:hyperlink          [0..*]  — 超链接包装器
- w:ins                [0..*]  — 修订插入
- w:del                [0..*]  — 修订删除
- w:bookmarkStart      [0..*]  — 书签锚点起始
- w:bookmarkEnd        [0..*]  — 书签锚点结束
- w:commentRangeStart  [0..*]  — 批注范围起始
- w:commentRangeEnd    [0..*]  — 批注范围结束
- w:proofErr           [0..*]  — 校对错误标记
- w:fldSimple          [0..*]  — 简单域
- w:sdt                [0..*]  — 内联内容控件
- w:smartTag           [0..*]  — 智能标记
```

**实用提示**：在 `w:pPr` 之后，其余子元素按文档阅读顺序出现。run、超链接、书签和批注范围根据它们在文本中的位置自由穿插。

---

## w:pPr（段落属性）

```
子元素顺序：
1.  w:pStyle            [0..1]  — 段落样式引用
2.  w:keepNext          [0..1]  — 与下段同页
3.  w:keepLines         [0..1]  — 段中不分页
4.  w:pageBreakBefore   [0..1]  — 段前分页
5.  w:framePr           [0..1]  — 文本框属性
6.  w:widowControl      [0..1]  — 孤行/寡行控制
7.  w:numPr             [0..1]  — 编号属性
8.  w:suppressLineNumbers [0..1]  — 抑制行号
9.  w:pBdr              [0..1]  — 段落边框
10. w:shd               [0..1]  — 底纹
11. w:tabs              [0..1]  — 制表位
12. w:suppressAutoHyphens [0..1]  — 抑制自动连字符
13. w:kinsoku           [0..1]  — CJK 禁则设置
14. w:wordWrap           [0..1]  — 换行
15. w:overflowPunct     [0..1]  — 标点溢出
16. w:topLinePunct      [0..1]  — 顶部标点压缩
17. w:autoSpaceDE       [0..1]  — 中西文间自动间距
18. w:autoSpaceDN       [0..1]  — 中文与数字间自动间距
19. w:bidi              [0..1]  — 从右到左段落
20. w:adjustRightInd    [0..1]  — 调整右缩进
21. w:snapToGrid        [0..1]  — 对齐网格
22. w:spacing            [0..1]  — 行距与段距
23. w:ind               [0..1]  — 缩进
24. w:contextualSpacing [0..1]  — 上下文间距
25. w:mirrorIndents     [0..1]  — 镜像缩进
26. w:suppressOverlap   [0..1]  — 抑制重叠
27. w:jc                [0..1]  — 对齐方式（left/center/right/both）
28. w:textDirection     [0..1]  — 文字方向
29. w:textAlignment     [0..1]  — 文字对齐
30. w:outlineLvl        [0..1]  — 大纲级别
31. w:divId             [0..1]  — div ID
32. w:rPr               [0..1]  — 段落标记的 run 属性
33. w:sectPr            [0..1]  — 分节符（此段落处结束该节）
34. w:pPrChange         [0..1]  — 修订的段落属性更改
```

---

## w:r（Run）

```
子元素顺序：
1. w:rPr               [0..1]  — run 属性（必须为第一个）

然后是以下任意（每个 run 通常一个）：
- w:t                  [0..*]  — 文本内容
- w:br                 [0..*]  — 换行（行、页、栏）
- w:tab                [0..*]  — 制表符
- w:cr                 [0..*]  — 回车
- w:sym               [0..*]  — 符号字符
- w:drawing            [0..*]  — DrawingML 对象（图片）
- w:pict               [0..*]  — VML 图片（旧式）
- w:fldChar            [0..*]  — 复杂域字符
- w:instrText          [0..*]  — 域指令文本
- w:delText            [0..*]  — 删除的文本（在 w:del 内）
- w:footnoteReference  [0..*]  — 脚注引用
- w:endnoteReference   [0..*]  — 尾注引用
- w:commentReference   [0..*]  — 批注引用
- w:lastRenderedPageBreak [0..*]  — 上次渲染的分页
```

---

## w:rPr（Run 属性）

```
子元素顺序：
1.  w:rStyle            [0..1]  — 字符样式引用
2.  w:rFonts            [0..1]  — 字体指定
3.  w:b                 [0..1]  — 粗体
4.  w:bCs               [0..1]  — 复杂文种粗体
5.  w:i                 [0..1]  — 斜体
6.  w:iCs               [0..1]  — 复杂文种斜体
7.  w:caps              [0..1]  — 全部大写
8.  w:smallCaps         [0..1]  — 小型大写
9.  w:strike            [0..1]  — 删除线
10. w:dstrike           [0..1]  — 双删除线
11. w:outline           [0..1]  — 轮廓
12. w:shadow            [0..1]  — 阴影
13. w:emboss            [0..1]  — 浮雕
14. w:imprint           [0..1]  — 印记
15. w:noProof           [0..1]  — 不校对
16. w:snapToGrid        [0..1]  — 对齐网格
17. w:vanish            [0..1]  — 隐藏文本
18. w:color             [0..1]  — 文本颜色
19. w:spacing            [0..1]  — 字符间距
20. w:w                 [0..1]  — 字符宽度缩放
21. w:kern              [0..1]  — 字距调整
22. w:position          [0..1]  — 垂直位置（升高/降低）
23. w:sz                [0..1]  — 字号（半点）
24. w:szCs              [0..1]  — 复杂文种字号
25. w:highlight         [0..1]  — 文本突出显示色
26. w:u                 [0..1]  — 下划线
27. w:effect            [0..1]  — 文本效果（动态）
28. w:bdr               [0..1]  — run 边框
29. w:shd               [0..1]  — run 底纹
30. w:vertAlign         [0..1]  — 上标/下标
31. w:rtl               [0..1]  — 从右到左
32. w:cs                [0..1]  — 复杂文种
33. w:lang              [0..1]  — 语言
34. w:rPrChange         [0..1]  — 修订的 run 属性更改
```

---

## w:tbl（表格）

```
子元素顺序：
1. w:tblPr              [1..1]  — 表格属性（必需，必须为第一个）
2. w:tblGrid            [1..1]  — 列宽定义（必需）
3. w:tr                 [1..*]  — 表格行
```

---

## w:tblPr（表格属性）

```
子元素顺序：
1.  w:tblStyle           [0..1]  — 表格样式引用
2.  w:tblpPr             [0..1]  — 表格定位
3.  w:tblOverlap         [0..1]  — 表格重叠
4.  w:bidiVisual         [0..1]  — 从右到左表格
5.  w:tblStyleRowBandSize [0..1]  — 行带大小
6.  w:tblStyleColBandSize [0..1]  — 列带大小
7.  w:tblW               [0..1]  — 首选表格宽度
8.  w:jc                 [0..1]  — 表格对齐
9.  w:tblCellSpacing     [0..1]  — 单元格间距
10. w:tblInd             [0..1]  — 表格距页边距缩进
11. w:tblBorders         [0..1]  — 表格边框
12. w:shd                [0..1]  — 表格底纹
13. w:tblLayout          [0..1]  — 固定或自动调整
14. w:tblCellMar         [0..1]  — 默认单元格边距
15. w:tblLook            [0..1]  — 条件格式标志
16. w:tblCaption         [0..1]  — 无障碍标题
17. w:tblDescription     [0..1]  — 无障碍描述
18. w:tblPrChange        [0..1]  — 修订的表格属性更改
```

---

## w:tr（表格行）

```
子元素顺序：
1. w:trPr               [0..1]  — 行属性（必须为第一个）
2. w:tc                  [1..*]  — 表格单元格
```

---

## w:trPr（表格行属性）

```
子元素顺序：
1.  w:cnfStyle           [0..1]  — 条件格式
2.  w:divId              [0..1]  — div ID
3.  w:gridBefore         [0..1]  — 首单元格前的网格列
4.  w:gridAfter          [0..1]  — 末单元格后的网格列
5.  w:wBefore            [0..1]  — 行前宽度
6.  w:wAfter             [0..1]  — 行后宽度
7.  w:cantSplit          [0..1]  — 跨页不拆分行
8.  w:trHeight           [0..1]  — 行高
9.  w:tblHeader          [0..1]  — 作为标题行重复
10. w:tblCellSpacing     [0..1]  — 单元格间距
11. w:jc                 [0..1]  — 行对齐
12. w:hidden             [0..1]  — 隐藏
13. w:ins                [0..1]  — 修订的行插入
14. w:del                [0..1]  — 修订的行删除
15. w:trPrChange         [0..1]  — 修订的行属性更改
```

---

## w:tc（表格单元格）

```
子元素顺序：
1. w:tcPr               [0..1]  — 单元格属性（必须为第一个）
2. w:p                   [1..*]  — 段落（至少一个）
3. w:tbl                 [0..*]  — 嵌套表格
```

---

## w:tcPr（表格单元格属性）

```
子元素顺序：
1.  w:cnfStyle           [0..1]  — 条件格式
2.  w:tcW                [0..1]  — 单元格宽度
3.  w:gridSpan           [0..1]  — 水平合并（跨列）
4.  w:hMerge             [0..1]  — 旧式水平合并
5.  w:vMerge             [0..1]  — 垂直合并
6.  w:tcBorders          [0..1]  — 单元格边框
7.  w:shd                [0..1]  — 单元格底纹
8.  w:noWrap             [0..1]  — 不换行
9.  w:tcMar              [0..1]  — 单元格边距
10. w:textDirection      [0..1]  — 文字方向
11. w:tcFitText          [0..1]  — 缩放以适应
12. w:vAlign             [0..1]  — 垂直对齐
13. w:hideMark           [0..1]  — 隐藏标记
14. w:tcPrChange         [0..1]  — 修订的单元格属性更改
```

---

## w:sectPr（节属性）

```
子元素顺序：
1.  w:headerReference    [0..*]  — 页眉引用（type: default/first/even）
2.  w:footerReference    [0..*]  — 页脚引用
3.  w:endnotePr          [0..1]  — 尾注属性
4.  w:footnotePr         [0..1]  — 脚注属性
5.  w:type               [0..1]  — 分节符类型（nextPage/continuous/evenPage/oddPage）
6.  w:pgSz               [0..1]  — 页面尺寸
7.  w:pgMar              [0..1]  — 页边距
8.  w:paperSrc           [0..1]  — 纸张来源
9.  w:pgBorders          [0..1]  — 页面边框
10. w:lnNumType          [0..1]  — 行号
11. w:pgNumType          [0..1]  — 页码
12. w:cols               [0..1]  — 分栏定义
13. w:formProt           [0..1]  — 窗体保护
14. w:vAlign             [0..1]  — 页面垂直对齐
15. w:noEndnote          [0..1]  — 不显示尾注
16. w:titlePg            [0..1]  — 首页页眉/页脚不同
17. w:textDirection      [0..1]  — 文字方向
18. w:bidi               [0..1]  — 从右到左
19. w:rtlGutter          [0..1]  — 右侧装订线
20. w:docGrid            [0..1]  — 文档网格
21. w:sectPrChange       [0..1]  — 修订的节属性更改
```

---

## w:hdr（页眉）/ w:ftr（页脚）

```
子元素（与 w:body 内容结构相同）：
1. w:p                   [0..*]  — 段落
2. w:tbl                 [0..*]  — 表格
3. w:sdt                 [0..*]  — 内容控件
```

页眉和页脚本质上是微型文档。它们遵循与 `w:body` 相同的内容模型，但没有末尾的 `w:sectPr`。
