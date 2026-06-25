function isConversationUserMessage(item) {
  return item?.kind === "message" && item.role === "user" && item.isContextPrelude !== true;
}

function isFinalAssistantMessage(item) {
  return item?.kind === "message" && item.role === "assistant" && item.phase === "final_answer";
}

export function splitConversationRounds(items) {
  const sourceItems = Array.isArray(items) ? items : [];

  if (sourceItems.length === 0) {
    return [];
  }

  const rounds = [];
  let current = null;

  function finalizeCurrent() {
    if (!current || current.endIndex <= current.startIndex) {
      current = null;
      return;
    }

    rounds.push(current);
    current = null;
  }

  for (let index = 0; index < sourceItems.length; index += 1) {
    const item = sourceItems[index];
    const startsNewRound =
      current &&
      current.hasFinalAnswer &&
      isConversationUserMessage(item);

    if (startsNewRound) {
      finalizeCurrent();
    }

    if (!current) {
      current = {
        startIndex: index,
        endIndex: index,
        hasFinalAnswer: false,
        userMessageCount: 0
      };
    }

    current.endIndex = index + 1;

    if (isConversationUserMessage(item)) {
      current.userMessageCount += 1;
    }

    if (isFinalAssistantMessage(item)) {
      current.hasFinalAnswer = true;
    }
  }

  finalizeCurrent();

  return rounds.map((round, index) => ({
    ...round,
    index: index + 1,
    total: rounds.length
  }));
}

export function countConversationRounds(items) {
  return splitConversationRounds(items).length;
}
