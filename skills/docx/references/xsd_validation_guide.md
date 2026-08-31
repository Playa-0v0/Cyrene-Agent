# XSD 验证指南

## 运行验证

```bash
# 依据 WML 子集 schema 验证
dotnet run --project minimax-docx validate input.docx --xsd assets/xsd/wml-subset.xsd

# 依据业务规则验证（场景 C 门控检查必需）
dotnet run --project minimax-docx validate input.docx --xsd assets/xsd/business-rules.xsd

# 同时依据两者验证
dotnet run --project minimax-docx validate input.docx --xsd assets/xsd/wml-subset.xsd --xsd assets/xsd/business-rules.xsd
```

---

## wml-subset.xsd 覆盖范围

子集 schema 验证最常见的 WordprocessingML 元素：

| 区域 | 验证的元素 |
|------|--------------------|
| 文档结构 | `w:document`、`w:body`、`w:sectPr` |
| 段落 | `w:p`、`w:pPr`、`w:r`、`w:rPr`、`w:t` |
| 表格 | `w:tbl`、`w:tblPr`、`w:tblGrid`、`w:tr`、`w:tc` |
| 样式 | `w:styles`、`w:style`、`w:docDefaults` |
| 列表 | `w:numbering`、`w:abstractNum`、`w:num` |
| 页眉/页脚 | `w:hdr`、`w:ftr` |
| 修订追踪 | `w:ins`、`w:del`、`w:rPrChange`、`w:pPrChange` |
| 批注 | `w:comment`、`w:commentRangeStart`、`w:commentRangeEnd` |

### 不覆盖的内容

- DrawingML 元素（`a:`、`pic:`、`wp:`）— 图片/形状内部结构
- VML 元素（`v:`、`o:`）— 旧式形状
- 数学元素（`m:`）— 公式
- 扩展命名空间（`w14`、`w15`、`w16*`）— 厂商扩展
- 自定义 XML 数据部件
- 关系和内容类型验证（结构性，非基于 schema）

---

## 解读错误

### 元素顺序错误

```
ERROR: Element 'w:jc' is not expected at this position.
Expected: w:spacing, w:ind, w:contextualSpacing, ...
Location: /word/document.xml, line 45
```

**原因**：子元素顺序错误。参见 `references/openxml_element_order.md`。
**修复**：重新排列子元素以匹配 schema 序列。

### 缺少必需元素

```
ERROR: Element 'w:tbl' missing required child 'w:tblPr'.
Location: /word/document.xml, line 102
```

**原因**：缺少必需的子元素。
**修复**：添加缺失的元素。表格要求同时具有 `w:tblPr` 和 `w:tblGrid`。

### 属性值无效

```
ERROR: Attribute 'w:val' has invalid value 'middle'.
Expected: 'left', 'center', 'right', 'both', 'distribute'
Location: /word/document.xml, line 78
```

**原因**：属性值不在允许的枚举中。
**修复**：使用错误信息中列出的合法值之一。

### 意外元素

```
ERROR: Element 'w:customTag' is not expected.
Location: /word/document.xml, line 200
```

**原因**：子集 schema 中未定义的元素。可能是厂商扩展。
**修复**：检查是否为已知扩展（w14/w15/w16）。如果是，通常安全。若未知，需调查或移除。

---

## 业务规则 XSD

`business-rules.xsd` schema 在标准 OpenXML 有效性之外强制执行项目特定约束：

| 规则 | 检查内容 |
|------|---------------|
| 必需样式 | `styles.xml` 中必须存在 `Normal`、`Heading1`-`Heading3`、`TableGrid` |
| 字体一致性 | `w:docDefaults` 字体匹配预期值 |
| 页边距范围 | 页边距在可接受范围内（720-2160 DXA） |
| 页面尺寸 | 必须为 A4 或 Letter |
| 标题层级 | 无跳级（如 H1 → H3 而无 H2） |
| 样式链 | `w:basedOn` 引用必须解析到已存在的样式 |

### 扩展业务规则

要添加项目特定规则，添加 `xs:assert` 或 `xs:restriction` 元素：

```xml
<!-- 要求最小 1 英寸页边距 -->
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

## 门控检查：场景 C 硬门控

在场景 C（应用模板）中，输出文档在交付前**必须**通过 `business-rules.xsd` 验证：

```
1. 应用模板      →  output.docx
2. 验证          →  dotnet run ... validate output.docx --xsd business-rules.xsd
3. 通过?         →  交付给用户
4. 失败?         →  修复问题，重新验证，重复直到通过
```

**这是硬门控。** 未通过业务规则验证的文档不可交付，即使它在 Word 中能正确打开。

---

## 误报

### 厂商扩展

来自扩展命名空间（`w14`、`w15`、`w16*`）的元素不在子集 schema 中，可能触发警告：

```
WARNING: Element '{http://schemas.microsoft.com/office/word/2010/wordml}shadow' is not expected.
```

这些通常可以安全忽略——它们是 Microsoft 为较新功能（如高级文本效果、批注扩展）所做的扩展。

### 标记兼容

文档可能包含带回退内容的 `mc:AlternateContent` 块。子集 schema 可能无法识别 `mc:` 命名空间处理。如果文档在 Word 中能正确打开，则这些是安全的。

### 推荐做法

1. 运行验证
2. 将**错误**视为必须修复
3. 审查**警告**——忽略已知厂商扩展，调查未知元素
4. 修复错误后，重新验证以确认
