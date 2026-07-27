# XSD 驗證指南

## 運行驗證

```bash
# 依據 WML 子集 schema 驗證
dotnet run --project minimax-docx validate input.docx --xsd assets/xsd/wml-subset.xsd

# 依據業務規則驗證（場景 C 門控檢查必需）
dotnet run --project minimax-docx validate input.docx --xsd assets/xsd/business-rules.xsd

# 同時依據兩者驗證
dotnet run --project minimax-docx validate input.docx --xsd assets/xsd/wml-subset.xsd --xsd assets/xsd/business-rules.xsd
```

---

## wml-subset.xsd 覆蓋範圍

子集 schema 驗證最常見的 WordprocessingML 元素：

| 區域 | 驗證的元素 |
|------|--------------------|
| 文檔結構 | `w:document`、`w:body`、`w:sectPr` |
| 段落 | `w:p`、`w:pPr`、`w:r`、`w:rPr`、`w:t` |
| 表格 | `w:tbl`、`w:tblPr`、`w:tblGrid`、`w:tr`、`w:tc` |
| 樣式 | `w:styles`、`w:style`、`w:docDefaults` |
| 列表 | `w:numbering`、`w:abstractNum`、`w:num` |
| 頁眉/頁腳 | `w:hdr`、`w:ftr` |
| 修訂追蹤 | `w:ins`、`w:del`、`w:rPrChange`、`w:pPrChange` |
| 批註 | `w:comment`、`w:commentRangeStart`、`w:commentRangeEnd` |

### 不覆蓋的內容

- DrawingML 元素（`a:`、`pic:`、`wp:`）— 圖片/形狀內部結構
- VML 元素（`v:`、`o:`）— 舊式形狀
- 數學元素（`m:`）— 公式
- 擴展命名空間（`w14`、`w15`、`w16*`）— 廠商擴展
- 自定義 XML 數據部件
- 關係和內容類型驗證（結構性，非基於 schema）

---

## 解讀錯誤

### 元素順序錯誤

```
ERROR: Element 'w:jc' is not expected at this position.
Expected: w:spacing, w:ind, w:contextualSpacing, ...
Location: /word/document.xml, line 45
```

**原因**：子元素順序錯誤。參見 `references/openxml_element_order.md`。
**修復**：重新排列子元素以匹配 schema 序列。

### 缺少必需元素

```
ERROR: Element 'w:tbl' missing required child 'w:tblPr'.
Location: /word/document.xml, line 102
```

**原因**：缺少必需的子元素。
**修復**：添加缺失的元素。表格要求同時具有 `w:tblPr` 和 `w:tblGrid`。

### 屬性值無效

```
ERROR: Attribute 'w:val' has invalid value 'middle'.
Expected: 'left', 'center', 'right', 'both', 'distribute'
Location: /word/document.xml, line 78
```

**原因**：屬性值不在允許的枚舉中。
**修復**：使用錯誤信息中列出的合法值之一。

### 意外元素

```
ERROR: Element 'w:customTag' is not expected.
Location: /word/document.xml, line 200
```

**原因**：子集 schema 中未定義的元素。可能是廠商擴展。
**修復**：檢查是否為已知擴展（w14/w15/w16）。如果是，通常安全。若未知，需調查或移除。

---

## 業務規則 XSD

`business-rules.xsd` schema 在標準 OpenXML 有效性之外強制執行項目特定約束：

| 規則 | 檢查內容 |
|------|---------------|
| 必需樣式 | `styles.xml` 中必須存在 `Normal`、`Heading1`-`Heading3`、`TableGrid` |
| 字體一致性 | `w:docDefaults` 字體匹配預期值 |
| 頁邊距範圍 | 頁邊距在可接受範圍內（720-2160 DXA） |
| 頁面尺寸 | 必須為 A4 或 Letter |
| 標題層級 | 無跳級（如 H1 → H3 而無 H2） |
| 樣式鏈 | `w:basedOn` 引用必須解析到已存在的樣式 |

### 擴展業務規則

要添加項目特定規則，添加 `xs:assert` 或 `xs:restriction` 元素：

```xml
<!-- 要求最小 1 英寸頁邊距 -->
<xs:element name="pgMar">
  <xs:complexType>
    <xs:attribute name="top" type="xs:integer">
      <xs:restriction>
        <xs:minInclusive value="1440" />
      </xs:restriction>
    </xs:attribute>
  </xs:complexType>
</xs:element>
```

---

## 門控檢查：場景 C 硬門控

在場景 C（應用模板）中，輸出文檔在交付前**必須**通過 `business-rules.xsd` 驗證：

```
1. 應用模板      →  output.docx
2. 驗證          →  dotnet run ... validate output.docx --xsd business-rules.xsd
3. 通過?         →  交付給用戶
4. 失敗?         →  修復問題，重新驗證，重複直到通過
```

**這是硬門控。** 未通過業務規則驗證的文檔不可交付，即使它在 Word 中能正確打開。

---

## 誤報

### 廠商擴展

來自擴展命名空間（`w14`、`w15`、`w16*`）的元素不在子集 schema 中，可能觸發警告：

```
WARNING: Element '{http://schemas.microsoft.com/office/word/2010/wordml}shadow' is not expected.
```

這些通常可以安全忽略——它們是 Microsoft 為較新功能（如高級文本效果、批註擴展）所做的擴展。

### 標記兼容

文檔可能包含帶回退內容的 `mc:AlternateContent` 塊。子集 schema 可能無法識別 `mc:` 命名空間處理。如果文檔在 Word 中能正確打開，則這些是安全的。

### 推薦做法

1. 運行驗證
2. 將**錯誤**視為必須修復
3. 審查**警告**——忽略已知廠商擴展，調查未知元素
4. 修復錯誤後，重新驗證以確認
