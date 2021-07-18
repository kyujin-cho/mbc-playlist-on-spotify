const FILTERED_WORDS = ['CF', '광고', '삽입곡', 'CM']

const title = process.argv[2]
let name = ''

for (let i = 0; i < title.length; i++) {
  if (title[i] === '(') {
    let level = 1
    let j = i
    for (; j < title.length; j++) {
      if (title[j] === '(') level++
      if (title[j] === ')') level--
      if (level === 0) {
        break
      }
    }
    const braceElement = title.substring(i, j + 1)
    i = j
    if (
      FILTERED_WORDS.filter((word) => braceElement.indexOf(word) > -1)
        .length === 0
    ) {
      name += braceElement
    }
  } else {
    name += title[i]
  }
}

console.log(name)
