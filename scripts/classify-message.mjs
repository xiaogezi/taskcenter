const collaborationPattern =
  /(?:做规划|规划).*(?:Claude|Codex|GLM|WorkBuddy|执行)|(?:Claude|Codex|GLM|WorkBuddy).*(?:分工|执行|规划)/i;
const businessGoalPattern =
  /总的来说|(?:目标|目的)是|提高.*(?:命中率|通过率|成功率)|起码能过|长期维护|以后一直/;
const discoveryPattern =
  /(?:github|GitHub).*(?:完善|功能需求|扩展点)|从.+角度.*(?:完善|缺口|功能)|还有哪些.*(?:完善|扩展|需求)/;
const feedbackPattern =
  /不满意|不好用|太少了?|有点少|没有新的|看不到|一脸懵|持续打开|每次.*刷新|乱码|没拿到|下边没有|没做(?:缓存|滑动|组件)|不专业|不是需求|在我看来是需求|怎么没有.*需求|一直输密码/;
const questionPattern =
  /(?:吗|么|呢|怎么(?:样|办|操作)?|什么|为什么|是否|有没有|可不可以|可以用吗|啥意思(?:啊)?|不太明白)[？?。！!\s]*$/;
const operationPattern =
  /^(?:(?:然后)?你?\s*)?(?:(?:github|GitHub).*(?:看下|看看)|从.+角度(?:看下|看看)|探索.+项目|完全卸载|这个也要处理|再试一下|可以\s*(?:做吧|执行吧)|(?:帮我)?(?:看下|看看|检索一下|检查一下|列举一下|强制重启|重启|打开页面|执行|运行|继续做|继续吧|做吧|启动一下|出来一下))/;
const requirementPattern =
  /我(?:还)?需要|我希望|还需要|还需|应该|得有|要有|新增|添加|支持|优化|完善|改成|改为|做一个|提供.*(?:功能|入口|页面)|功能.*(?:需要|支持)/;

export const messageClasses = [
  "requirement",
  "feedback",
  "discovery",
  "business_goal",
  "operation",
  "question",
  "collaboration",
  "other",
];

export function classifyMessage(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "other";
  if (collaborationPattern.test(normalized)) return "collaboration";
  if (businessGoalPattern.test(normalized)) return "business_goal";
  if (discoveryPattern.test(normalized)) return "discovery";
  if (feedbackPattern.test(normalized)) return "feedback";
  if (questionPattern.test(normalized)) return "question";
  if (operationPattern.test(normalized)) return "operation";
  if (requirementPattern.test(normalized)) return "requirement";
  return "other";
}
