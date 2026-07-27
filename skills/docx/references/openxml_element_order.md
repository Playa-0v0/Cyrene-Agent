# OpenXML 子元素順序規則

OpenXML 中的元素順序由 XSD schema 定義。順序錯誤會產生無效文檔，Word 可能拒絕打開或靜默修復（可能導致數據丟失）。

> **關鍵規則**：屬性元素（`*Pr`）必須始終是其父元素的**第一個子元素**。

---

## w:document

```
子元素順序：
1. w:background       [0..1]  — 頁面背景色/填充
2. w:body              [0..1]  — 文檔內容容器
```

---

## w:body

```
子元素順序（重複組）：
1. w:p                 [0..*]  — 段落
2. w:tbl               [0..*]  — 表格
3. w:sdt               [0..*]  — 結構化文檔標籤（內容控件）
4. w:sectPr            [0..1]  — 最後一個子元素：末節屬性
```

注意：`w:p`、`w:tbl` 和 `w:sdt` 按文檔順序交替出現。唯一的嚴格規則是 `w:sectPr` 必須是 `w:body` 的**最後一個子元素**。

---

## w:p（段落）

```
子元素順序：
1. w:pPr               [0..1]  — 段落屬性（必須為第一個）

然後是以下任意組合（按文檔順序交替）：
- w:r                  [0..*]  — run（文本運行）
- w:hyperlink          [0..*]  — 超鏈接包裝器
- w:ins                [0..*]  — 修訂插入
- w:del                [0..*]  — 修訂刪除
- w:bookmarkStart      [0..*]  — 書籤錨點起始
- w:bookmarkEnd        [0..*]  — 書籤錨點結束
- w:commentRangeStart  [0..*]  — 批註範圍起始
- w:commentRangeEnd    [0..*]  — 批註範圍結束
- w:proofErr           [0..*]  — 校對錯誤標記
- w:fldSimple          [0..*]  — 簡單域
- w:sdt                [0..*]  — 內聯內容控件
- w:smartTag           [0..*]  — 智能標記
```

**實用提示**：在 `w:pPr` 之後，其餘子元素按文檔閱讀順序出現。run、超鏈接、書籤和批註範圍根據它們在文本中的位置自由穿插。

---

## w:pPr（段落屬性）

```
子元素順序：
1.  w:pStyle            [0..1]  — 段落樣式引用
2.  w:keepNext          [0..1]  — 與下段同頁
3.  w:keepLines         [0..1]  — 段中不分頁
4.  w:pageBreakBefore   [0..1]  — 段前分頁
5.  w:framePr           [0..1]  — 文本框屬性
6.  w:widowControl      [0..1]  — 孤行/寡行控制
7.  w:numPr             [0..1]  — 編號屬性
8.  w:suppressLineNumbers [0..1]  — 抑制行號
9.  w:pBdr              [0..1]  — 段落邊框
10. w:shd               [0..1]  — 底紋
11. w:tabs              [0..1]  — 製表位
12. w:suppressAutoHyphens [0..1]  — 抑制自動連字符
13. w:kinsoku           [0..1]  — CJK 禁則設置
14. w:wordWrap           [0..1]  — 換行
15. w:overflowPunct     [0..1]  — 標點溢出
16. w:topLinePunct      [0..1]  — 頂部標點壓縮
17. w:autoSpaceDE       [0..1]  — 中西文間自動間距
18. w:autoSpaceDN       [0..1]  — 中文與數字間自動間距
19. w:bidi              [0..1]  — 從右到左段落
20. w:adjustRightInd    [0..1]  — 調整右縮進
21. w:snapToGrid        [0..1]  — 對齊網格
22. w:spacing            [0..1]  — 行距與段距
23. w:ind               [0..1]  — 縮進
24. w:contextualSpacing [0..1]  — 上下文間距
25. w:mirrorIndents     [0..1]  — 鏡像縮進
26. w:suppressOverlap   [0..1]  — 抑制重疊
27. w:jc                [0..1]  — 對齊方式（left/center/right/both）
28. w:textDirection     [0..1]  — 文字方向
29. w:textAlignment     [0..1]  — 文字對齊
30. w:outlineLvl        [0..1]  — 大綱級別
31. w:divId             [0..1]  — div ID
32. w:rPr               [0..1]  — 段落標記的 run 屬性
33. w:sectPr            [0..1]  — 分節符（此段落處結束該節）
34. w:pPrChange         [0..1]  — 修訂的段落屬性更改
```

---

## w:r（Run）

```
子元素順序：
1. w:rPr               [0..1]  — run 屬性（必須為第一個）

然後是以下任意（每個 run 通常一個）：
- w:t                  [0..*]  — 文本內容
- w:br                 [0..*]  — 換行（行、頁、欄）
- w:tab                [0..*]  — 製表符
- w:cr                 [0..*]  — 回車
- w:sym               [0..*]  — 符號字符
- w:drawing            [0..*]  — DrawingML 對象（圖片）
- w:pict               [0..*]  — VML 圖片（舊式）
- w:fldChar            [0..*]  — 複雜域字符
- w:instrText          [0..*]  — 域指令文本
- w:delText            [0..*]  — 刪除的文本（在 w:del 內）
- w:footnoteReference  [0..*]  — 腳註引用
- w:endnoteReference   [0..*]  — 尾註引用
- w:commentReference   [0..*]  — 批註引用
- w:lastRenderedPageBreak [0..*]  — 上次渲染的分頁
```

---

## w:rPr（Run 屬性）

```
子元素順序：
1.  w:rStyle            [0..1]  — 字符樣式引用
2.  w:rFonts            [0..1]  — 字體指定
3.  w:b                 [0..1]  — 粗體
4.  w:bCs               [0..1]  — 複雜文種粗體
5.  w:i                 [0..1]  — 斜體
6.  w:iCs               [0..1]  — 複雜文種斜體
7.  w:caps              [0..1]  — 全部大寫
8.  w:smallCaps         [0..1]  — 小型大寫
9.  w:strike            [0..1]  — 刪除線
10. w:dstrike           [0..1]  — 雙刪除線
11. w:outline           [0..1]  — 輪廓
12. w:shadow            [0..1]  — 陰影
13. w:emboss            [0..1]  — 浮雕
14. w:imprint           [0..1]  — 印記
15. w:noProof           [0..1]  — 不校對
16. w:snapToGrid        [0..1]  — 對齊網格
17. w:vanish            [0..1]  — 隱藏文本
18. w:color             [0..1]  — 文本顏色
19. w:spacing            [0..1]  — 字符間距
20. w:w                 [0..1]  — 字符寬度縮放
21. w:kern              [0..1]  — 字距調整
22. w:position          [0..1]  — 垂直位置（升高/降低）
23. w:sz                [0..1]  — 字號（半點）
24. w:szCs              [0..1]  — 複雜文種字號
25. w:highlight         [0..1]  — 文本突出顯示色
26. w:u                 [0..1]  — 下劃線
27. w:effect            [0..1]  — 文本效果（動態）
28. w:bdr               [0..1]  — run 邊框
29. w:shd               [0..1]  — run 底紋
30. w:vertAlign         [0..1]  — 上標/下標
31. w:rtl               [0..1]  — 從右到左
32. w:cs                [0..1]  — 複雜文種
33. w:lang              [0..1]  — 語言
34. w:rPrChange         [0..1]  — 修訂的 run 屬性更改
```

---

## w:tbl（表格）

```
子元素順序：
1. w:tblPr              [1..1]  — 表格屬性（必需，必須為第一個）
2. w:tblGrid            [1..1]  — 列寬定義（必需）
3. w:tr                 [1..*]  — 表格行
```

---

## w:tblPr（表格屬性）

```
子元素順序：
1.  w:tblStyle           [0..1]  — 表格樣式引用
2.  w:tblpPr             [0..1]  — 表格定位
3.  w:tblOverlap         [0..1]  — 表格重疊
4.  w:bidiVisual         [0..1]  — 從右到左表格
5.  w:tblStyleRowBandSize [0..1]  — 行帶大小
6.  w:tblStyleColBandSize [0..1]  — 列帶大小
7.  w:tblW               [0..1]  — 首選表格寬度
8.  w:jc                 [0..1]  — 表格對齊
9.  w:tblCellSpacing     [0..1]  — 單元格間距
10. w:tblInd             [0..1]  — 表格距頁邊距縮進
11. w:tblBorders         [0..1]  — 表格邊框
12. w:shd                [0..1]  — 表格底紋
13. w:tblLayout          [0..1]  — 固定或自動調整
14. w:tblCellMar         [0..1]  — 默認單元格邊距
15. w:tblLook            [0..1]  — 條件格式標誌
16. w:tblCaption         [0..1]  — 無障礙標題
17. w:tblDescription     [0..1]  — 無障礙描述
18. w:tblPrChange        [0..1]  — 修訂的表格屬性更改
```

---

## w:tr（表格行）

```
子元素順序：
1. w:trPr               [0..1]  — 行屬性（必須為第一個）
2. w:tc                  [1..*]  — 表格單元格
```

---

## w:trPr（表格行屬性）

```
子元素順序：
1.  w:cnfStyle           [0..1]  — 條件格式
2.  w:divId              [0..1]  — div ID
3.  w:gridBefore         [0..1]  — 首單元格前的網格列
4.  w:gridAfter          [0..1]  — 末單元格後的網格列
5.  w:wBefore            [0..1]  — 行前寬度
6.  w:wAfter             [0..1]  — 行後寬度
7.  w:cantSplit          [0..1]  — 跨頁不拆分行
8.  w:trHeight           [0..1]  — 行高
9.  w:tblHeader          [0..1]  — 作為標題行重複
10. w:tblCellSpacing     [0..1]  — 單元格間距
11. w:jc                 [0..1]  — 行對齊
12. w:hidden             [0..1]  — 隱藏
13. w:ins                [0..1]  — 修訂的行插入
14. w:del                [0..1]  — 修訂的行刪除
15. w:trPrChange         [0..1]  — 修訂的行屬性更改
```

---

## w:tc（表格單元格）

```
子元素順序：
1. w:tcPr               [0..1]  — 單元格屬性（必須為第一個）
2. w:p                   [1..*]  — 段落（至少一個）
3. w:tbl                 [0..*]  — 嵌套表格
```

---

## w:tcPr（表格單元格屬性）

```
子元素順序：
1.  w:cnfStyle           [0..1]  — 條件格式
2.  w:tcW                [0..1]  — 單元格寬度
3.  w:gridSpan           [0..1]  — 水平合併（跨列）
4.  w:hMerge             [0..1]  — 舊式水平合併
5.  w:vMerge             [0..1]  — 垂直合併
6.  w:tcBorders          [0..1]  — 單元格邊框
7.  w:shd                [0..1]  — 單元格底紋
8.  w:noWrap             [0..1]  — 不換行
9.  w:tcMar              [0..1]  — 單元格邊距
10. w:textDirection      [0..1]  — 文字方向
11. w:tcFitText          [0..1]  — 縮放以適應
12. w:vAlign             [0..1]  — 垂直對齊
13. w:hideMark           [0..1]  — 隱藏標記
14. w:tcPrChange         [0..1]  — 修訂的單元格屬性更改
```

---

## w:sectPr（節屬性）

```
子元素順序：
1.  w:headerReference    [0..*]  — 頁眉引用（type: default/first/even）
2.  w:footerReference    [0..*]  — 頁腳引用
3.  w:endnotePr          [0..1]  — 尾註屬性
4.  w:footnotePr         [0..1]  — 腳註屬性
5.  w:type               [0..1]  — 分節符類型（nextPage/continuous/evenPage/oddPage）
6.  w:pgSz               [0..1]  — 頁面尺寸
7.  w:pgMar              [0..1]  — 頁邊距
8.  w:paperSrc           [0..1]  — 紙張來源
9.  w:pgBorders          [0..1]  — 頁面邊框
10. w:lnNumType          [0..1]  — 行號
11. w:pgNumType          [0..1]  — 頁碼
12. w:cols               [0..1]  — 分欄定義
13. w:formProt           [0..1]  — 窗體保護
14. w:vAlign             [0..1]  — 頁面垂直對齊
15. w:noEndnote          [0..1]  — 不顯示尾註
16. w:titlePg            [0..1]  — 首頁頁眉/頁腳不同
17. w:textDirection      [0..1]  — 文字方向
18. w:bidi               [0..1]  — 從右到左
19. w:rtlGutter          [0..1]  — 右側裝訂線
20. w:docGrid            [0..1]  — 文檔網格
21. w:sectPrChange       [0..1]  — 修訂的節屬性更改
```

---

## w:hdr（頁眉）/ w:ftr（頁腳）

```
子元素（與 w:body 內容結構相同）：
1. w:p                   [0..*]  — 段落
2. w:tbl                 [0..*]  — 表格
3. w:sdt                 [0..*]  — 內容控件
```

頁眉和頁腳本質上是微型文檔。它們遵循與 `w:body` 相同的內容模型，但沒有末尾的 `w:sectPr`。
